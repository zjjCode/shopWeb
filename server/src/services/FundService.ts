/**
 * @file server/src/services/FundService.ts
 * @description 资金记账服务：账户开户 + 入账 / 出账 / 转账（含负债结转对）
 * @module services
 * @see docs/04-flows.md F6（556 行起，重点 F6.2 余额快照方案、F6.6 结转对写入铁律）
 * @see docs/03-database.md §3.6.4（方案 A+：单式流水 + 对手方 + 交易组号）
 * @see prisma/schema.prisma:1092（FundAccount）、:1134（FundTransaction）
 * @author 软件开发团队
 * @created 2026-09-07
 *
 * 这是资金链（T061 记账 → T070 余额/充值 → T080 退款 → T090 对账）的第一块。
 * 四条铁律（违反任意一条都会造成资损或账目漂移）：
 *
 * 1. **金额一律 `bigint`（单位：分）**。禁止 `number` / `float` / `parseFloat`。
 *    所有入参先过 `MoneyUtil.toBigint` 归一化，落库前再断言一次是 bigint。
 * 2. **防超扣靠 DB 条件更新，不靠应用层判断**。出账一律
 *    `updateMany({ where: { id, balance: { gte: amount } }, data: { balance: { decrement: amount } } })`。
 *    先 SELECT 再判断再 UPDATE 在并发下必然超扣（`CHECK(balance >= 0)` 只能在事后兜底）。
 * 3. **`beforeBalance` / `afterBalance` 必须在行锁下读取**。条件更新拿不到这两个值，
 *    若用「更新前无锁快照」作为 before，并发下会记出错误的余额快照（详见 {@link FundService.doPost} 注释）。
 *    且该行锁**必须和后续更新在同一事务内**：autocommit 下单条语句执行完立即释放锁 = 没锁。
 * 4. **所有写方法必须接收可选 `tx`**，且**不传时自开事务**。传了 `tx` 就在调用方事务内执行
 *    （如 PaymentService 事务 B），一旦退回默认 client，回滚时账务与流水都回不去；
 *    没传则本服务自开 `withTransaction`，保证「读快照 → 写流水 → 改余额」三步原子。
 *
 * ⚠️ `isLiability` 口径表（**最容易填错且填错无报错**的一项，务必照此表填）：
 *
 *   判断依据是「**这笔钱平台是不是欠用户的**」，与钱从哪个渠道进来无关。
 *
 *   | 场景                             | 平台收到钱 | 是否欠用户         | isLiability |
 *   |----------------------------------|-----------|-------------------|-------------|
 *   | 用户充值 100 元（PLATFORM_RECHARGE_IN） | 是      | **是**（可消费/提现）| **true**    |
 *   | 渠道支付买 100 元商品（ORDER_PAY）      | 是      | 否（是货款非储值） | **false**   |
 *   | 余额支付买 100 元（LIABILITY_SETTLE_OUT）| 否（动已收的钱）| 负债**减少**  | **true**（冲减侧）|
 *
 *   一句话记忆：**充值收款 = true，订单收款 = false，余额消费的冲减侧 = true**。
 *   填错的表现是「负债总额算错但没有任何报错」——对账时才会暴露，属于最难查的那类问题。
 *
 * ⚠️ 字段名核对（已逐一回到 prisma/schema.prisma 确认 @map，非凭印象）：
 *
 *   fund_accounts（模型 FundAccount，@@map("fund_accounts")）：
 *     id                           （BigInt，主键）
 *     account_no     ← accountNo        @map("account_no")
 *     account_type   ← accountType      @map("account_type")
 *     user_id        ← userId           @map("user_id")
 *     balance                            （BigInt，**无 @map**，列名即 balance）
 *     frozen_balance ← frozenBalance    @map("frozen_balance")
 *     total_in       ← totalIn          @map("total_in")
 *     total_out      ← totalOut         @map("total_out")
 *     version                            （Int，**无 @map**，乐观锁）
 *     status                             （**无 @map**，枚举 AccountStatus）
 *     唯一键 uk_user_account(user_id, account_type) → Prisma where 输入名 `userId_accountType`
 *
 *   fund_transactions（模型 FundTransaction，@@map("fund_transactions")）：
 *     tx_no                    ← txNo                    @map("tx_no")         （唯一）
 *     account_id               ← accountId               @map("account_id")
 *     account_no               ← accountNo               @map("account_no")
 *     account_type             ← accountType             @map("account_type")
 *     counterparty_account_id  ← counterpartyAccountId   @map("counterparty_account_id")
 *     counterparty_account_no  ← counterpartyAccountNo   @map("counterparty_account_no")
 *     tx_group_no              ← txGroupNo               @map("tx_group_no")
 *     biz_type                 ← bizType                 @map("biz_type")
 *     direction                                            （**无 @map**，枚举 FundDirection）
 *     amount                                               （**无 @map**，BigInt，恒正）
 *     is_liability             ← isLiability             @map("is_liability")
 *     before_balance           ← beforeBalance           @map("before_balance")
 *     after_balance            ← afterBalance            @map("after_balance")
 *     order_no / payment_no / refund_no / recharge_no / related_tx_no / biz_no
 *     operator_type / operator_id / operator_name / idempotency_key / remark
 *     extra                                                （Json?，**无 @map**）
 *     唯一键 uk_biz_idem(biz_type, idempotency_key)
 */

import { Prisma, type PrismaClient } from '@prisma/client';
import { AccountStatus, FundAccountType, FundBizType, FundDirection } from '@/constants/enums';
// OperatorType 仅作类型使用：走 `import type` 避免打包进运行时，也满足 lint 的 consistent-type-imports
import type { OperatorType } from '@/constants/enums';
import { BusinessError, NotFoundError, ValidationError } from '@/core/errors';
import { ErrorCode } from '@/core/errors/errorCodes';
import {
  fundTxNo as generateFundTxNo,
  txGroupNo as generateTxGroupNo,
  userBalanceAccountNo,
} from '@/core/idGenerator';
import { MoneyUtil } from '@/core/money';
import { getPrisma } from '@/core/prisma';
import { withTransaction } from '@/core/transaction';

/**
 * 本服务用到的 Prisma 委托。
 *
 * @description 用 `Pick` 收窄，既满足注入可打桩（单测传假对象），又不把整个 PrismaClient 暴露给服务层。
 * `$queryRaw` 用于账户行锁（`SELECT ... FOR UPDATE`）
 */
export type DbClient = Pick<PrismaClient, 'fundAccount' | 'fundTransaction' | '$queryRaw'>;

/** 外部注入的事务客户端（调用方在事务内调用本服务时传入） */
export type TxClient = Prisma.TransactionClient;

/** 账户快照（行锁下读取，用于计算 before / after 余额） */
export interface FundAccountSnapshot {
  id: bigint;
  accountNo: string;
  accountType: FundAccountType;
  status: AccountStatus;
  /** 当前余额（分） */
  balance: bigint;
  /** 冻结余额（分） */
  frozenBalance: bigint;
  version: number;
}

/** 记账入参（入账 / 出账共用，方向由调用方指定） */
export interface PostFundInput {
  /** 账户 ID */
  accountId: bigint;
  /** 金额（分，bigint，恒为正数；方向由 {@link credit} / {@link debit} 决定） */
  amount: bigint;
  /** 业务类型 */
  bizType: FundBizType;
  /**
   * 是否计入「平台负债」口径（仅 PLATFORM_CASH 流水需要区分，默认 false）。
   *
   * ⚠️ 取值口径见文件头的 `isLiability` 口径表：充值收款 = true，订单收款 = false，
   * 余额消费的冲减侧 = true。USER_BALANCE 流水恒 false。
   */
  isLiability?: boolean;
  /** 对手方账户 ID（资金流向的另一端，可空） */
  counterpartyAccountId?: bigint | null;
  /** 对手方账户号（冗余，便于检索，可空） */
  counterpartyAccountNo?: string | null;
  /** 交易组号：同一笔业务的多条流水共享（结转对的绑定键） */
  txGroupNo?: string | null;
  /**
   * 显式指定流水号。
   *
   * @description 幂等重放时用：同一 `txNo` 重复入账会撞 `tx_no` 唯一键（P2002），
   * 被判定为幂等命中 → 返回已有流水、**不重复加减余额**。不传则自动生成。
   */
  txNo?: string;
  orderNo?: string | null;
  paymentNo?: string | null;
  refundNo?: string | null;
  rechargeNo?: string | null;
  /** 冲正时必填原流水号 */
  relatedTxNo?: string | null;
  /** 其它业务单号（手工单号等） */
  bizNo?: string | null;
  operatorType: OperatorType;
  /** 操作人 ID（SYSTEM 时填 0） */
  operatorId: bigint;
  operatorName?: string | null;
  /** 幂等号（配合 uk_biz_idem 唯一键） */
  idempotencyKey?: string | null;
  remark?: string | null;
  /**
   * 附加信息（Json 列）。
   *
   * ⚠️ Prisma `Json` 字段走 `JSON.stringify`，**遇到 bigint 直接抛
   * `TypeError: Do not know how to serialize a BigInt`**，且项目的 `jsonReplacer` 只在响应层、
   * DB 层无保护。`Prisma.InputJsonValue` 类型不含 bigint，编译期即可挡住 —— 若要写金额请先 `.toString()`。
   */
  extra?: Prisma.InputJsonValue | null;
}

/** 入账入参（方向固定为 IN） */
export type CreditInput = PostFundInput;
/** 出账入参（方向固定为 OUT） */
export type DebitInput = PostFundInput;

/** 转账入参（同一 `txGroupNo` 下先 IN 后 OUT） */
export interface TransferInput {
  /** 出账账户 ID */
  fromAccountId: bigint;
  /** 入账账户 ID */
  toAccountId: bigint;
  /** 金额（分，bigint，恒正） */
  amount: bigint;
  /** 出账侧业务类型 */
  bizType: FundBizType;
  /** 入账侧业务类型（结转对两侧可能不同，缺省同 {@link TransferInput.bizType}） */
  inBizType?: FundBizType;
  /** 出账侧是否计入负债口径 */
  outIsLiability?: boolean;
  /** 入账侧是否计入负债口径 */
  inIsLiability?: boolean;
  /** 交易组号（不传则自动生成） */
  txGroupNo?: string;
  orderNo?: string | null;
  paymentNo?: string | null;
  refundNo?: string | null;
  rechargeNo?: string | null;
  bizNo?: string | null;
  operatorType: OperatorType;
  operatorId: bigint;
  operatorName?: string | null;
  remark?: string | null;
}

/** 记账结果 */
export interface FundResult {
  /** 流水号 */
  txNo: string;
  /** 账户 ID */
  accountId: bigint;
  /** 账户号 */
  accountNo: string;
  /** 方向 */
  direction: FundDirection;
  /** 金额（分，bigint） */
  amount: bigint;
  /** 变动前余额（分） */
  beforeBalance: bigint;
  /** 变动后余额（分） */
  afterBalance: bigint;
  /** 是否幂等命中（true = 该 txNo 已记过账，本次未改动余额） */
  duplicated: boolean;
}

/** 转账结果（两条流水共享同一 `txGroupNo`） */
export interface TransferResult {
  /** 入账侧结果（先写） */
  credit: FundResult;
  /** 出账侧结果（后写） */
  debit: FundResult;
  /** 交易组号 */
  txGroupNo: string;
}

/** 负债结转对结算结果（三条流水共享同一 `txGroupNo`，见 {@link FundService.doSettleLiability}） */
export interface SettleResult {
  /** 交易组号 */
  txGroupNo: string;
  /** 用户侧流水结果（余额支付 OUT / 退款 IN） */
  user: FundResult;
  /** 平台侧结转 IN 流水结果（先写） */
  platformIn: FundResult;
  /** 平台侧结转 OUT 流水结果（后写） */
  platformOut: FundResult;
}

/** `SELECT ... FOR UPDATE` 返回的原始行（列名是 snake_case，与 @map 后的 DB 列一致） */
interface LockRow {
  id: bigint | number;
  account_no: string;
  account_type: string;
  status: string;
  balance: bigint | number;
  frozen_balance: bigint | number;
  version: number;
}

/**
 * 资金记账服务。
 *
 * @description 依赖可注入，单测用假 Prisma 打桩验证防超扣条件、事务边界与幂等。
 */
export class FundService {
  /** 默认 Prisma 客户端（未传 tx 时使用） */
  private readonly prisma: DbClient;

  /**
   * @param prisma Prisma 客户端，缺省取全局单例
   */
  constructor(prisma: DbClient = getPrisma()) {
    this.prisma = prisma;
  }

  /**
   * 入账：`balance += amount`、`totalIn += amount`，写一条 `direction=IN` 流水。
   *
   * @description 事务语义（与 {@link FundService.debit} / {@link FundService.transfer} 对称）：
   * **传了 `tx` → 在调用方事务内执行**；**没传 → 自开 `withTransaction`**。
   * 为什么没传也要自开：记账是「行锁读快照 → 写流水 → 条件更新余额」三步，
   * 这三步必须原子是**操作自身的属性**，与调用方有没有开事务无关。
   * 把 invariant 收在本服务内部，T070 充值 / T080 退款就不必各自记着「先开个事务」，
   * 漏一个就是**静默错账**（流水与余额对不上，且没有异常信号）。
   *
   * @param input 入账入参
   * @param tx 事务客户端（不传则自开事务，label `fund.credit`）
   * @returns 记账结果
   * @throws {ValidationError} 金额非正数（90002）
   * @throws {NotFoundError} 账户不存在（61001）
   * @throws {BusinessError} 账户非 ACTIVE（61003）、余额不足（61002）
   */
  async credit(input: CreditInput, tx?: TxClient): Promise<FundResult> {
    if (tx !== undefined) {
      return this.doPost(this.resolveClient(tx), input, FundDirection.IN);
    }
    return withTransaction((t) => this.doPost(this.resolveClient(t), input, FundDirection.IN), {
      label: 'fund.credit',
    });
  }

  /**
   * 出账：`balance -= amount`、`totalOut += amount`，**余额不足抛错**，写一条 `direction=OUT` 流水。
   *
   * @description 事务语义同 {@link FundService.credit}：传 `tx` 走调用方事务，不传则自开
   * `withTransaction`（label `fund.debit`），保证「读快照 → 写流水 → 扣余额」三步原子。
   *
   * @param input 出账入参
   * @param tx 事务客户端（不传则自开事务，label `fund.debit`）
   * @returns 记账结果
   * @throws {BusinessError} 余额不足（61002）
   * @throws {ValidationError} 金额非正数（90002）
   * @throws {NotFoundError} 账户不存在（61001）
   * @throws {BusinessError} 账户非 ACTIVE（61003）
   */
  async debit(input: DebitInput, tx?: TxClient): Promise<FundResult> {
    if (tx !== undefined) {
      return this.doPost(this.resolveClient(tx), input, FundDirection.OUT);
    }
    return withTransaction((t) => this.doPost(this.resolveClient(t), input, FundDirection.OUT), {
      label: 'fund.debit',
    });
  }

  /**
   * 转账（F6.6 结转对）：同一 `txGroupNo` 下**先 IN 后 OUT**，两笔流水 + 两个账户余额变更在同一事务内。
   *
   * @description 为什么必须「先 IN 后 OUT」：F6.6 写入铁律 2 —— 先写入账侧（余额 +N）
   * 再写出账侧（余额 −N），中间态恒为 `+N`，不会触发任何账户的 `CHECK(balance >= 0)`；
   * 反之若平台现金账户余额 < N，先出账会直接把事务打失败。
   *
   * 死锁预防：两个账户**按 `id` 升序**依次加行锁（{@link FundService.lockAccountsInOrder}），
   * 保证不同转账方向对同一对账户的加锁顺序一致。
   *
   * @param input 转账入参
   * @param tx 事务客户端（**强烈建议传入**：不传时本方法自开事务，无法与外部业务同事务回滚）
   * @returns 转账结果
   * @throws {BusinessError} 出账方余额不足（61002）→ 整个事务回滚，入账方余额不受影响
   */
  async transfer(input: TransferInput, tx?: TxClient): Promise<TransferResult> {
    if (tx !== undefined) {
      return this.doTransfer(this.resolveClient(tx), input);
    }
    // 未传 tx 时自开事务：保证「两笔流水 + 两个余额变更」的原子性（F6.2 方案 A）
    return withTransaction((t) => this.doTransfer(this.resolveClient(t), input), {
      label: 'fund.transfer',
    });
  }

  /**
   * 按 `(userId, accountType)` 命中 `uk_user_account` 取账户，不存在则开户。
   *
   * @description 仅适用于 **USER_BALANCE**（`userId` 非空）。PLATFORM_CASH 的 `userId` 恒为 NULL，
   * 而 MySQL 唯一索引允许多个 NULL，用它开户会绕过唯一约束造出多个平台账户 —— 故显式拒绝。
   * 并发开户靠 `uk_user_account` 冲突（P2002）兜底：捕获后重读返回，不抛错。
   *
   * @param userId 用户 ID
   * @param accountType 账户类型（当前仅支持 USER_BALANCE）
   * @param tx 事务客户端（不传则用默认 client）
   * @returns 账户快照
   * @throws {ValidationError} 对 PLATFORM_CASH 调用（60001）
   */
  async getOrCreateAccount(
    userId: bigint,
    accountType: FundAccountType = FundAccountType.USER_BALANCE,
    tx?: DbClient,
  ): Promise<FundAccountSnapshot> {
    const client = this.resolveClient(tx);

    if (accountType !== FundAccountType.USER_BALANCE) {
      throw new ValidationError('仅 USER_BALANCE 账户可按用户开户；PLATFORM_CASH 的 userId 为 NULL，不适用唯一约束', {
        code: ErrorCode.FUND_RECORD_FAILED,
      });
    }

    const existing = await client.fundAccount.findUnique({
      where: { userId_accountType: { userId, accountType } },
    });
    if (existing !== null) {
      return this.toSnapshot(existing);
    }

    try {
      const created = await client.fundAccount.create({
        data: {
          // 账户号确定性生成（同 userId + 同日期 → 同号），重试/补偿不会产生第二个账号
          accountNo: userBalanceAccountNo(userId),
          accountType,
          userId,
          name: `用户余额账户(${userId})`,
          balance: 0n,
        },
      });
      return this.toSnapshot(created);
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      // 并发开户：uk_user_account 冲突说明别的请求刚建好，重读即可
      const raced = await client.fundAccount.findUnique({
        where: { userId_accountType: { userId, accountType } },
      });
      if (raced === null) {
        throw error;
      }
      return this.toSnapshot(raced);
    }
  }

  // --------------------------------------------------------------------------
  // 私有实现
  // --------------------------------------------------------------------------

  /**
   * 取本次操作的客户端：**传入的 `tx` 优先**。
   *
   * @description 这是事务红线的唯一收口点。一旦这里写成忽略 `tx`，
   * 调用方（PaymentService 事务 B）回滚时账务与流水都回不去，属于资金事故。
   * @param tx 事务客户端（可空）
   * @returns 实际执行写操作的客户端
   */
  private resolveClient(tx?: TxClient | DbClient): DbClient {
    return (tx ?? this.prisma) as DbClient;
  }

  /**
   * 记账主流程：行锁读快照 → 校验 → 写流水（幂等抢占）→ 条件更新余额。
   *
   * ── 为什么 `beforeBalance` / `afterBalance` 必须在 `FOR UPDATE` 行锁下取 ──
   *
   * 条件更新（`updateMany`）只能返回 `count`，拿不到变动前的余额，所以 before 必须从一次读里来。
   * 若这次读**不加锁**，会出现「快照对但更新被并发改过」的错账：
   *
   *   读 balance=100 → 另一事务 credit 50（balance=150）→ 本事务 debit 100
   *   → `WHERE balance >= 100` 命中（150 >= 100）→ 更新成功，但记的 before 是 100、after 是 0，
   *     而真实变化是 150 → 50。**账目与实际余额永久对不上**。
   *
   * `SELECT ... FOR UPDATE` 把同一账户的记账严格串行化（F6.2 方案 A），
   * 使「读到的余额」到「更新完成」之间不可能被插队，`before` 必然等于上一条流水的 `after`。
   * 代价是同账户记账串行 —— 一期支付回调量远低于瓶颈，可接受（F6.2 已做容量评估）。
   *
   * ── ⚠️ 行锁与后续更新**必须在同一个事务里**，不要把 `withTransaction` 优化掉 ──
   *
   * MySQL 的 `FOR UPDATE` **只在事务中持有行锁**：autocommit 模式下单条语句执行完立即释放，
   * 等于没锁。若把 `credit` / `debit` 的 `withTransaction` 去掉、直接拿默认 client 执行，
   * 锁会在「读快照」与「更新余额」之间被释放，并发插队就会重新出现，
   * 于是记出 before=100 / after=0 而真实变化是 150→50 的**静默错账**（无异常信号，最难查）。
   * 这正是 `credit` / `debit` 不传 `tx` 时也要自开事务的原因。
   *
   * ── 为什么「先写流水、后更新余额」而不是反过来 ──
   *
   * 流水的 `tx_no` 唯一键是本次记账的幂等闸门：先 INSERT 撞 P2002 即说明这笔账已记过，
   * 直接返回已有流水、**不再动余额**。若先更新余额再 INSERT，重复请求会把余额加/减两次，
   * 靠后面的 P2002 已经拦不住了。两者在同一事务内，更新失败则流水一并回滚。
   *
   * @param client 实际客户端（已解析 tx）
   * @param input 记账入参
   * @param direction 方向
   * @returns 记账结果
   * @throws {ValidationError} 金额非正数（90002）
   * @throws {NotFoundError} 账户不存在（61001）
   * @throws {BusinessError} 账户非 ACTIVE（61003）、余额不足（61002）、记账失败（60001）
   */
  private async doPost(client: DbClient, input: PostFundInput, direction: FundDirection): Promise<FundResult> {
    // 1. 金额归一化：一律 bigint（单位：分），禁止 number/float
    const amount = MoneyUtil.toBigint(input.amount, 'amount');
    if (amount <= 0n) {
      throw new ValidationError('记账金额必须大于 0', { code: ErrorCode.FIELD_FORMAT_INVALID });
    }

    // 2. 行锁读快照（before 的唯一可信来源）
    const account = await this.lockAccount(client, input.accountId);
    this.assertActive(account);

    const beforeBalance = account.balance;
    const afterBalance =
      direction === FundDirection.IN ? beforeBalance + amount : beforeBalance - amount;
    if (afterBalance < 0n) {
      throw new BusinessError('余额不足', { code: ErrorCode.BALANCE_NOT_ENOUGH });
    }

    const txNo = input.txNo ?? generateFundTxNo();

    // 3. 写流水（抢占 tx_no 唯一键做幂等）；撞键即幂等命中，直接返回，绝不重复动余额
    try {
      await client.fundTransaction.create({
        data: {
          txNo,
          accountId: account.id,
          accountNo: account.accountNo,
          accountType: account.accountType,
          counterpartyAccountId: input.counterpartyAccountId ?? null,
          counterpartyAccountNo: input.counterpartyAccountNo ?? null,
          txGroupNo: input.txGroupNo ?? null,
          bizType: input.bizType,
          direction,
          amount,
          isLiability: input.isLiability ?? false,
          beforeBalance,
          afterBalance,
          orderNo: input.orderNo ?? null,
          paymentNo: input.paymentNo ?? null,
          refundNo: input.refundNo ?? null,
          rechargeNo: input.rechargeNo ?? null,
          relatedTxNo: input.relatedTxNo ?? null,
          bizNo: input.bizNo ?? null,
          operatorType: input.operatorType,
          operatorId: input.operatorId,
          operatorName: input.operatorName ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          remark: input.remark ?? null,
          extra: input.extra ?? Prisma.DbNull,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // 幂等命中：返回已有流水，余额保持原样
        return this.buildResult(txNo, account, direction, amount, beforeBalance, afterBalance, true);
      }
      throw error;
    }

    // 4. 条件更新余额（防超扣红线：出账必须带 `balance >= amount`）
    const updated = await client.fundAccount.updateMany({
      where:
        direction === FundDirection.OUT
          ? { id: account.id, balance: { gte: amount } }
          : { id: account.id },
      data:
        direction === FundDirection.IN
          ? {
              balance: { increment: amount },
              totalIn: { increment: amount },
              version: { increment: 1 },
            }
          : {
              balance: { decrement: amount },
              totalOut: { increment: amount },
              version: { increment: 1 },
            },
    });

    if (updated.count === 0) {
      // 走到这里说明行锁下读到的余额是够的、更新却没命中 —— 只可能是并发把余额改小了，
      // 按余额不足处理（绝不静默放过，否则流水已写而余额未扣，账目直接裂开）
      throw new BusinessError('余额不足', { code: ErrorCode.BALANCE_NOT_ENOUGH });
    }

    return this.buildResult(txNo, account, direction, amount, beforeBalance, afterBalance, false);
  }

  /**
   * 转账内部实现（已在事务内）。
   *
   * @param client 事务客户端
   * @param input 转账入参
   * @returns 转账结果
   */
  private async doTransfer(client: DbClient, input: TransferInput): Promise<TransferResult> {
    const amount = MoneyUtil.toBigint(input.amount, 'amount');
    if (amount <= 0n) {
      throw new ValidationError('转账金额必须大于 0', { code: ErrorCode.FIELD_FORMAT_INVALID });
    }
    if (input.fromAccountId === input.toAccountId) {
      throw new ValidationError('转账的收付账户不能相同', { code: ErrorCode.FIELD_FORMAT_INVALID });
    }

    // 先按 id 升序对两个账户加行锁，固定加锁顺序防死锁；后续 doPost() 再次 FOR UPDATE 同一行是幂等的
    await this.lockAccountsInOrder(client, [input.fromAccountId, input.toAccountId]);

    const txGroupNo = input.txGroupNo ?? generateTxGroupNo();
    const common = {
      amount,
      txGroupNo,
      orderNo: input.orderNo ?? null,
      paymentNo: input.paymentNo ?? null,
      refundNo: input.refundNo ?? null,
      rechargeNo: input.rechargeNo ?? null,
      bizNo: input.bizNo ?? null,
      operatorType: input.operatorType,
      operatorId: input.operatorId,
      operatorName: input.operatorName ?? null,
      remark: input.remark ?? null,
    };

    // ① 先 IN（入账侧余额 +N，中间态恒安全）
    const credit = await this.doPost(client, {
      ...common,
      accountId: input.toAccountId,
      bizType: input.inBizType ?? input.bizType,
      isLiability: input.inIsLiability ?? false,
      counterpartyAccountId: input.fromAccountId,
    }, FundDirection.IN);

    // ② 后 OUT（出账侧余额 −N；余额不足则抛错，整个事务回滚，入账侧不受影响）
    const debit = await this.doPost(client, {
      ...common,
      accountId: input.fromAccountId,
      bizType: input.bizType,
      isLiability: input.outIsLiability ?? false,
      counterpartyAccountId: input.toAccountId,
      counterpartyAccountNo: credit.accountNo,
    }, FundDirection.OUT);

    return { credit, debit, txGroupNo };
  }

  /**
   * 锁账户行并读快照（`SELECT ... FOR UPDATE`）。
   *
   * @description **必须在事务内调用**：MySQL 的 `FOR UPDATE` 只在事务中持有行锁，
   * autocommit 下单条语句执行完立即释放，等于没锁。
   * @param client 客户端
   * @param accountId 账户 ID
   * @returns 账户快照
   * @throws {NotFoundError} 账户不存在（61001）
   */
  private async lockAccount(client: DbClient, accountId: bigint): Promise<FundAccountSnapshot> {
    const rows = await client.$queryRaw<LockRow[]>`
      SELECT id, account_no, account_type, status, balance, frozen_balance, version
        FROM fund_accounts
       WHERE id = ${accountId}
         FOR UPDATE
    `;

    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundError('资金账户不存在', { code: ErrorCode.BALANCE_ACCOUNT_NOT_FOUND });
    }

    return {
      id: toBigint(row.id),
      accountNo: row.account_no,
      accountType: row.account_type as FundAccountType,
      status: row.status as AccountStatus,
      balance: toBigint(row.balance),
      frozenBalance: toBigint(row.frozen_balance),
      version: row.version,
    };
  }

  /**
   * 按 `id` 升序依次锁定多个账户（防死锁），返回「账户 ID → 快照」映射。
   *
   * @description 转账 / 负债结转对涉及两个账户，若两个方向的操各自按不同顺序加锁，
   * 就会形成「A 等 B、B 等 A」的死锁环。固定按 `id` 升序加锁是标准的破环手段。
   * 注：`docs/04-flows.md` F6.6 铁律 4 描述的是「先 USER_BALANCE 后 PLATFORM_CASH」这一**具体场景**下的顺序，
   * 本方法采用更通用的 id 升序规则，覆盖任意两账户组合。
   * 返回映射而非数组：调用方传入的账户 ID 顺序不一定等于加锁顺序，用 ID 取快照最稳。
   *
   * @param client 客户端
   * @param accountIds 账户 ID 列表
   * @returns 账户 ID → 快照 的 Map（已按 id 升序串行加锁）
   */
  private async lockAccountsInOrder(
    client: DbClient,
    accountIds: readonly bigint[],
  ): Promise<Map<bigint, FundAccountSnapshot>> {
    const ordered = [...new Set(accountIds)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const map = new Map<bigint, FundAccountSnapshot>();
    for (const accountId of ordered) {
      // eslint-disable-next-line no-await-in-loop -- 顺序敏感：必须按 id 升序串行加锁，并行会破坏加锁顺序
      map.set(accountId, await this.lockAccount(client, accountId));
    }
    return map;
  }

  /**
   * 负债结转对结算（F6.6 支付 / F9.3 退款共用原语）。
   *
   * @description 余额支付与余额退款在账面上互为反向，但骨架完全一致：都是「用户余额账户一条流水」
   * +「平台现金账户一对结转流水（先 IN 后 OUT）」，三条流水共享同一 `txGroupNo`。
   * 把这套最易错（方向 / isLiability 取反 / 先 IN 后 OUT 顺序）的逻辑收口到一处，
   * 支付侧 {@link FundService.recordBalancePayment} 与退款侧 {@link FundService.recordBalanceRefund} 只做配置。
   *
   * 三条铁律（违反任一都是资损且**无报错**）：
   * 1. **先 IN 后 OUT**（平台这对）：先写 `LIABILITY_SETTLE_IN`（平台余额 +N），再写 `LIABILITY_SETTLE_OUT`
   *    （平台余额 −N）。中间态恒为 +N，不会触发平台 `CHECK(balance >= 0)`；反之若平台余额 < N 时先 OUT 会直接打失败整笔。
   * 2. **`isLiability` 由调用方按口径传入**：支付口径（`recordBalancePayment`）IN→false / OUT→true；
   *    退款是**反向结转**（F9.3，注意取反）IN→true / OUT→false。填反了的表现是「负债总额算错但没有任何报错」。
   * 3. **用户流水在平台这对之前写**：用户余额账户与平台现金账户是两个不同账户，先锁/先写哪一侧不影响一致性，
   *    但用户侧余额不足必须**最先**抛错——否则平台流水已写而用户余额未扣，账目裂开。
   *
   * 防超扣：用户侧 OUT 走条件更新 `balance >= amount`；平台侧 OUT 在 IN（已 +N）之后再走 `balance >= amount`，
   * 此时余额 = before+N（before≥0）必然 ≥ N，绝不会误判。
   *
   * 幂等：三条流水的 `idempotencyKey` 统一为业务单号（paymentNo / refundNo），复合唯一键
   * `(biz_type, idempotency_key)` 因 `bizType` 各异不会互撞。真正的重入闸门是调用方事务的
   * 条件更新（payment/refund 单 `WHERE status=?`），故本方法不处理 P2002（撞键即说明原子事务被重放，交给外层回滚）。
   *
   * @param client 事务客户端（**必须**在调用方事务内，否则回滚时账已记、钱凭空多）
   * @param cfg 结算配置（账户 ID / 金额 / 业务单号 / 各侧 bizType 与 isLiability / 操作人）
   * @returns 结算结果（txGroupNo + 三条流水结果）
   * @throws {BusinessError} 用户余额不足（61002）→ 整笔回滚
   */
  private async doSettleLiability(
    client: DbClient,
    cfg: {
      userAccountId: bigint;
      platformAccountId: bigint;
      amount: bigint;
      orderNo: string;
      bizNo: string;
      idempotencyKey: string;
      userBizType: FundBizType;
      userDirection: FundDirection;
      settleInLiability: boolean;
      settleOutLiability: boolean;
      operatorType: OperatorType;
      operatorId: bigint;
      operatorName?: string | null;
      remark?: string | null;
      txGroupNo: string;
      /** 业务单号透传：支付单号 / 退款单号（仅其一有值），落到三条流水的 paymentNo / refundNo 便于对账追踪 */
      paymentNo?: string | null;
      refundNo?: string | null;
    },
  ): Promise<SettleResult> {
    const amount = MoneyUtil.toBigint(cfg.amount, 'amount');
    if (amount <= 0n) {
      throw new ValidationError('结算金额必须大于 0', { code: ErrorCode.FIELD_FORMAT_INVALID });
    }
    if (cfg.userAccountId === cfg.platformAccountId) {
      throw new ValidationError('结算的收付账户不能相同', { code: ErrorCode.FIELD_FORMAT_INVALID });
    }

    // 按 id 升序加锁（防死锁），拿到两侧快照
    const locked = await this.lockAccountsInOrder(client, [
      cfg.userAccountId,
      cfg.platformAccountId,
    ]);
    const userSnap = locked.get(cfg.userAccountId);
    const platSnap = locked.get(cfg.platformAccountId);
    if (userSnap === undefined || platSnap === undefined) {
      throw new NotFoundError('结算账户不存在', { code: ErrorCode.BALANCE_ACCOUNT_NOT_FOUND });
    }
    this.assertActive(userSnap);
    this.assertActive(platSnap);

    // 用户侧余额变动（OUT 减 / IN 加），不足立即抛错（先于平台流水，避免账目裂开）
    const userBefore = userSnap.balance;
    const userAfter =
      cfg.userDirection === FundDirection.IN ? userBefore + amount : userBefore - amount;
    if (userAfter < 0n) {
      throw new BusinessError('余额不足', { code: ErrorCode.BALANCE_NOT_ENOUGH });
    }

    // 平台侧一对结转：IN 后 OUT，净额为 0（IN 后余额 = before+N，OUT 后 = before）
    const platBefore = platSnap.balance;
    const platAfterIn = platBefore + amount;

    // 公共字段
    const common = {
      amount,
      txGroupNo: cfg.txGroupNo,
      orderNo: cfg.orderNo,
      paymentNo: cfg.paymentNo ?? null,
      refundNo: cfg.refundNo ?? null,
      idempotencyKey: cfg.idempotencyKey,
      operatorType: cfg.operatorType,
      operatorId: cfg.operatorId,
      operatorName: cfg.operatorName ?? null,
      remark: cfg.remark ?? null,
    };

    // ① 用户侧流水（BALANCE_CONSUME 支付 / BALANCE_REFUND 退款）：恒 false，不参与平台负债口径
    const userResult = await this.doPost(
      client,
      {
        ...common,
        accountId: cfg.userAccountId,
        bizType: cfg.userBizType,
        isLiability: false,
        counterpartyAccountId: cfg.platformAccountId,
        counterpartyAccountNo: platSnap.accountNo,
      },
      cfg.userDirection,
    );

    // ② 平台侧 IN：负债转收入（支付）/ 负债增（退款反向结转），先写（中间态 +N 安全）
    const platInResult = await this.doPost(
      client,
      {
        ...common,
        accountId: cfg.platformAccountId,
        bizType: FundBizType.LIABILITY_SETTLE_IN,
        isLiability: cfg.settleInLiability,
        counterpartyAccountId: cfg.userAccountId,
        counterpartyAccountNo: userSnap.accountNo,
      },
      FundDirection.IN,
    );

    // ③ 平台侧 OUT：冲减负债（支付）/ 收入减（退款反向结转），后写
    const platOutResult = await this.doPost(
      client,
      {
        ...common,
        accountId: cfg.platformAccountId,
        bizType: FundBizType.LIABILITY_SETTLE_OUT,
        isLiability: cfg.settleOutLiability,
        counterpartyAccountId: cfg.userAccountId,
        counterpartyAccountNo: userSnap.accountNo,
      },
      FundDirection.OUT,
    );

    // 防超扣兜底校验：用户 OUT 时 doPost 内部条件更新已拦，但仍确认（IN 侧不会失败）；
    // 平台 OUT 在 IN 之后，余额 = platBefore+amount ≥ amount（platBefore≥0），亦不会失败。
    // 若极端情况下用户 OUT 的 count=0（并发把余额改小），doPost 已抛 BALANCE_NOT_ENOUGH。
    void platAfterIn;

    return {
      txGroupNo: cfg.txGroupNo,
      user: userResult,
      platformIn: platInResult,
      platformOut: platOutResult,
    };
  }

  /**
   * 余额支付结算（F6.6 负债结转对）。
   *
   * @description 用户用余额支付时**没有任何现金进入平台账户**（钱在充值时已进账，那时是负债），
   * 必须在账上写结转对体现「卖出货 = 收入」。三条流水同 `txGroupNo`：
   *
   * | # | 账户            | bizType               | 方向 | isLiability | 含义              |
   * |---|-----------------|-----------------------|------|-------------|-------------------|
   * | ① | USER_BALANCE    | `BALANCE_CONSUME`     | OUT  | false       | 用户余额扣减      |
   * | ② | PLATFORM_CASH   | `LIABILITY_SETTLE_IN` | IN   | **false**   | 负债转收入（+N）  |
   * | ③ | PLATFORM_CASH   | `LIABILITY_SETTLE_OUT`| OUT  | **true**    | 冲减负债（−N）    |
   *
   * 收入恒等式：L3 = Σ PLATFORM 流水中 is_liability=false 的净额 = 用户消费的 200 元（本例）。
   *
   * 平台现金账户**必须查出来用、不存在即抛错，绝不自动创建**（种子数据预置）；用户余额账户走
   * `getOrCreateAccount`（首用余额支付的用户此前可能没开户）。账户 ID 解析后传入 {@link FundService.doSettleLiability}。
   *
   * @param input 余额支付结算入参（userId / amount / orderNo / paymentNo / 操作人，可选 txGroupNo / tx）
   * @param tx 事务客户端（**强烈建议传入**：与 PaymentService 事务 B' 同事务回滚，漏传则自开事务）
   * @returns 结算结果（txGroupNo + 三条流水）
   * @throws {BusinessError} 用户余额不足（61002）/ 平台现金账户不存在（60001）
   */
  async recordBalancePayment(
    input: {
      userId: bigint;
      amount: bigint;
      orderNo: string;
      paymentNo: string;
      operatorType: OperatorType;
      operatorId: bigint;
      operatorName?: string | null;
      remark?: string | null;
      txGroupNo?: string;
      tx?: TxClient;
    },
    tx?: TxClient,
  ): Promise<SettleResult> {
    const run = async (client: DbClient) => {
      const userAccount = await this.getOrCreateAccount(
        input.userId,
        FundAccountType.USER_BALANCE,
        client,
      );
      const platformAccount = await client.fundAccount.findFirst({
        where: { accountType: FundAccountType.PLATFORM_CASH },
        select: { id: true, accountNo: true },
      });
      if (platformAccount === null) {
        throw new BusinessError('平台现金账户不存在，拒绝记账', {
          code: ErrorCode.FUND_RECORD_FAILED,
        });
      }
      return this.doSettleLiability(client, {
        userAccountId: userAccount.id,
        platformAccountId: platformAccount.id,
        amount: input.amount,
        orderNo: input.orderNo,
        bizNo: input.paymentNo,
        idempotencyKey: input.paymentNo,
        paymentNo: input.paymentNo,
        refundNo: null,
        userBizType: FundBizType.BALANCE_CONSUME,
        userDirection: FundDirection.OUT,
        settleInLiability: false,
        settleOutLiability: true,
        operatorType: input.operatorType,
        operatorId: input.operatorId,
        operatorName: input.operatorName ?? null,
        remark: input.remark ?? `余额支付 ${input.paymentNo}`,
        txGroupNo: input.txGroupNo ?? generateTxGroupNo(),
      });
    };
    if (tx !== undefined) {
      return run(this.resolveClient(tx));
    }
    return withTransaction((t) => run(this.resolveClient(t)), { label: 'fund.balance_pay' });
  }

  /**
   * 余额退款结算（F9.3 反向结转对）。
   *
   * @description 退款是支付的**反向**：用户余额账户 IN（BALANCE_REFUND，恒 false）+ 平台一对结转
   * **取值取反**（与支付口径相反）：② `LIABILITY_SETTLE_IN` → **true**（负债增）先写；
   * ③ `LIABILITY_SETTLE_OUT` → **false**（收入减）后写。照抄 schema 注释的支付口径会把负债方向记反
   * （负债总额算错但无报错）。其余与 {@link FundService.recordBalancePayment} 同构。
   *
   * @param input 余额退款结算入参（userId / amount / orderNo / refundNo / 操作人，可选 txGroupNo / tx）
   * @param tx 事务客户端（**必须传入**：与 RefundService 事务 C 同事务回滚）
   * @returns 结算结果（txGroupNo + 三条流水）
   * @throws {BusinessError} 用户余额不足（61002，理论上退款 IN 不会触发）/ 平台现金账户不存在（60001）
   */
  async recordBalanceRefund(
    input: {
      userId: bigint;
      amount: bigint;
      orderNo: string;
      refundNo: string;
      operatorType: OperatorType;
      operatorId: bigint;
      operatorName?: string | null;
      remark?: string | null;
      txGroupNo?: string;
      tx?: TxClient;
    },
    tx?: TxClient,
  ): Promise<SettleResult> {
    const run = async (client: DbClient) => {
      const userAccount = await this.getOrCreateAccount(
        input.userId,
        FundAccountType.USER_BALANCE,
        client,
      );
      const platformAccount = await client.fundAccount.findFirst({
        where: { accountType: FundAccountType.PLATFORM_CASH },
        select: { id: true, accountNo: true },
      });
      if (platformAccount === null) {
        throw new BusinessError('平台现金账户不存在，拒绝记账', {
          code: ErrorCode.FUND_RECORD_FAILED,
        });
      }
      return this.doSettleLiability(client, {
        userAccountId: userAccount.id,
        platformAccountId: platformAccount.id,
        amount: input.amount,
        orderNo: input.orderNo,
        bizNo: input.refundNo,
        idempotencyKey: input.refundNo,
        paymentNo: null,
        refundNo: input.refundNo,
        userBizType: FundBizType.BALANCE_REFUND,
        userDirection: FundDirection.IN,
        settleInLiability: true,
        settleOutLiability: false,
        operatorType: input.operatorType,
        operatorId: input.operatorId,
        operatorName: input.operatorName ?? null,
        remark: input.remark ?? `余额退款 ${input.refundNo}`,
        txGroupNo: input.txGroupNo ?? generateTxGroupNo(),
      });
    };
    if (tx !== undefined) {
      return run(this.resolveClient(tx));
    }
    return withTransaction((t) => run(this.resolveClient(t)), { label: 'fund.balance_refund' });
  }

  /**
   * 断言账户处于 ACTIVE（停用 / 冻结账户拒绝记账）。
   *
   * @param account 账户快照
   * @throws {BusinessError} 账户已冻结（61003）
   */
  private assertActive(account: FundAccountSnapshot): void {
    if (account.status !== AccountStatus.ACTIVE) {
      throw new BusinessError('余额账户已冻结，无法记账', {
        code: ErrorCode.BALANCE_ACCOUNT_FROZEN,
      });
    }
  }

  /** 构造记账结果 */
  private buildResult(
    txNo: string,
    account: FundAccountSnapshot,
    direction: FundDirection,
    amount: bigint,
    beforeBalance: bigint,
    afterBalance: bigint,
    duplicated: boolean,
  ): FundResult {
    return {
      txNo,
      accountId: account.id,
      accountNo: account.accountNo,
      direction,
      amount,
      beforeBalance,
      afterBalance,
      duplicated,
    };
  }

  /** 把 Prisma 账户记录转成快照（金额统一转 bigint） */
  private toSnapshot(row: {
    id: bigint;
    accountNo: string;
    accountType: FundAccountType;
    status: AccountStatus;
    balance: bigint;
    frozenBalance: bigint;
    version: number;
  }): FundAccountSnapshot {
    return {
      id: row.id,
      accountNo: row.accountNo,
      accountType: row.accountType,
      status: row.status,
      balance: toBigint(row.balance),
      frozenBalance: toBigint(row.frozenBalance),
      version: row.version,
    };
  }
}

/**
 * 归一化为 bigint（分）。
 *
 * @description MySQL `BIGINT` 经 Prisma 返回 JS `bigint`，但不同驱动 / 聚合场景下可能给到 number。
 * 统一收口，保证落到 `amount` / `beforeBalance` / `afterBalance` 的一定是 bigint。
 * @param value 原始值
 * @returns bigint 金额
 */
function toBigint(value: bigint | number): bigint {
  return typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
}

/**
 * 判断异常是否为 Prisma 唯一键冲突（P2002）。
 *
 * @description 只有 P2002 表示「已记过这笔账 / 已开过户」，可走幂等分支；
 * 其余（连库失败、字段超长）必须原样抛出，吞掉会让真实故障被误判成幂等命中。
 * @param error 捕获到的异常
 * @returns 是否为唯一键冲突
 */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
