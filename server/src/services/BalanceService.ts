/**
 * @file server/src/services/BalanceService.ts
 * @description 用户余额账户服务：开户 / 查余额 / 流水明细 / 充值入账（委托 FundService 记账）
 * @module services
 * @see docs/04-flows.md F6（支付与资金流水）、F6.6（余额支付结转对）
 * @see prisma/schema.prisma FundAccount（1092）/ FundTransaction（1134）
 * @see src/services/FundService.ts（下层记账引擎，本服务只编排、不直接写 fund_transactions）
 * @author 软件开发团队
 * @created 2026-09-09
 *
 * 为什么需要这一层（而不是让 Controller 直接调 FundService）：
 * 1. **越权红线收敛到一处**：余额与流水都是「按用户隔离」的隐私/资金数据。所有查询都先按
 *    `userId` 解析出 `accountId`（fund_transactions 没有 userId 列，归属关系靠
 *    `uk_user_account(userId, accountType)` 唯一约束锚定），漏了就是越权漏洞 —— 这里统一兜底。
 * 2. **充值幂等**：渠道异步回调可能重发，必须用充值单号当幂等键，否则重复加钱。
 * 3. **事务边界**：充值入账若要开事务，把 `tx` 透传给 FundService.credit，不能让它退回默认 client
 *    （否则回滚时账务回不去，造成静默错账）。
 *
 * 字段名核对清单（以 schema @map 后 snake_case 为准）：
 * - fund_accounts: id / account_no / account_type / user_id / balance / frozen_balance /
 *   total_in / total_out / version / status
 * - fund_transactions: tx_no / account_id / account_type / amount / direction / before_balance /
 *   after_balance / biz_type / recharge_no / operator_type / operator_id / idempotency_key
 */

import { type PrismaClient } from '@prisma/client';
import { AccountStatus, FundAccountType, FundBizType, OperatorType } from '@/constants/enums';
import { BusinessError, NotFoundError, ValidationError } from '@/core/errors';
import { ErrorCode } from '@/core/errors/errorCodes';
import { getPrisma } from '@/core/prisma';
import { MoneyUtil } from '@/core/money';
import { withTransaction } from '@/core/transaction';
import { FundService, type TxClient } from '@/services/FundService';

/** 本服务直接查询的 Prisma 委托（账户查询 + 流水查询，记账全部委托 FundService） */
type DbClient = Pick<PrismaClient, 'fundAccount' | 'fundTransaction'>;

/** 充值入参 */
export interface RechargeInput {
  /** 金额（分，bigint，必须为正） */
  amount: bigint;
  /** 充值单号（同时作为记账幂等键，渠道重发不会重复加钱） */
  rechargeNo: string;
}

/** 流水分页查询入参 */
export interface ListTransactionsInput {
  page?: number;
  pageSize?: number;
}

/** 流水分页返回 */
export interface ListTransactionsResult {
  list: unknown[];
  total: number;
}

/** 余额账户快照（对外只暴露必要字段） */
export interface BalanceAccountView {
  accountNo: string;
  balance: bigint;
  status: AccountStatus;
}

/**
 * 用户余额账户服务。
 *
 * @description 金额一律 bigint（分），禁止裸算术；记账全权委托 FundService（防超扣条件更新 +
 * 行锁读快照 + 幂等唯一键都在那里）。本服务只负责「按 userId 解析账户」「充值幂等键编排」
 * 「事务透传」三件事。
 */
export class BalanceService {
  /** 默认 Prisma 客户端（未传 tx 时使用，仅供自身查询 fundAccount / fundTransaction） */
  private readonly prisma: DbClient;
  /** 下层记账引擎（注入可打桩） */
  private readonly fund: FundService;

  /**
   * @param prisma Prisma 客户端，缺省取全局单例
   * @param fundService 记账引擎，缺省构造默认实例
   */
  constructor(prisma: DbClient = getPrisma(), fundService: FundService = new FundService()) {
    this.prisma = prisma;
    this.fund = fundService;
  }

  /**
   * 取或开通用户的余额账户（委托 FundService，命中 `uk_user_account` 即复用）。
   *
   * @param userId 用户 ID
   * @returns 账户快照（含 accountNo / status / balance）
   */
  async getOrCreateAccount(userId: bigint): Promise<BalanceAccountView> {
    const account = await this.fund.getOrCreateAccount(userId, FundAccountType.USER_BALANCE);
    return { accountNo: account.accountNo, balance: account.balance, status: account.status };
  }

  /**
   * 查询用户余额（bigint，单位分）。
   *
   * @description 越权红线：where 必须带 userId；账户不存在 → 61001。
   * @param userId 用户 ID
   * @returns 余额（分，bigint）
   * @throws {NotFoundError} 账户不存在（61001）
   */
  async getBalance(userId: bigint): Promise<bigint> {
    const account = await this.prisma.fundAccount.findFirst({
      // 越权红线：必须带 userId（fund_transactions 无此列，靠 account 归属锚定）
      where: { userId, accountType: FundAccountType.USER_BALANCE },
      select: { balance: true },
    });
    if (account === null) {
      throw new NotFoundError('余额账户不存在', { code: ErrorCode.BALANCE_ACCOUNT_NOT_FOUND });
    }
    return MoneyUtil.toBigint(account.balance, 'balance');
  }

  /**
   * 余额流水明细（分页）。
   *
   * @description 越权红线：先按 userId 解析账户（where 带 userId），再用解析出的 accountId 查流水；
   * fund_transactions 无 userId 列，账户归属即边界。按创建时间倒序。
   * @param userId 用户 ID
   * @param input 分页参数（page 从 1 起，pageSize 默认 20）
   * @returns { list, total }
   * @throws {NotFoundError} 账户不存在（61001）
   */
  async listTransactions(userId: bigint, input: ListTransactionsInput = {}): Promise<ListTransactionsResult> {
    const { page = 1, pageSize = 20 } = input;

    // 越权红线：先按 userId 解析账户（where 带 userId）
    const account = await this.prisma.fundAccount.findFirst({
      where: { userId, accountType: FundAccountType.USER_BALANCE },
      select: { id: true },
    });
    if (account === null) {
      throw new NotFoundError('余额账户不存在', { code: ErrorCode.BALANCE_ACCOUNT_NOT_FOUND });
    }

    const skip = Math.max(0, (page - 1) * pageSize);
    const take = pageSize;

    const [rows, total] = await Promise.all([
      this.prisma.fundTransaction.findMany({
        where: { accountId: account.id },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.fundTransaction.count({ where: { accountId: account.id } }),
    ]);

    return { list: rows, total };
  }

  /**
   * 充值入账（调 FundService.credit，带幂等键，余额不足/冻结由下层或本层拦截）。
   *
   * @deprecated ⚠️ **不可用于充值主路径**（QA 定级 P1，2026-09-10）。
   *
   * 本方法**只记用户侧单条流水**（`BALANCE_RECHARGE`），
   * **不记平台侧负债流水**（`PLATFORM_RECHARGE_IN` / `is_liability=true`）。
   *
   * 误用后果：用户余额 +N、平台现金账户无对应流水、平台负债口径少记 N。
   * 单看 `fund_transactions` **发现不了**（平台侧那笔钱根本没记），
   * 只有「Σ用户余额 == Σ平台负债」跨表交叉校验才暴露，**且无任何报错**。
   *
   * 充值主路径请改用 `PaymentService.settleRecharge`
   * （双流水：平台负债 + 用户入账，共享 `txGroupNo`，见 F14.1 ②）。
   *
   * 当前无业务调用方，保留仅作「单侧冲正」的候选实现。
   *
   * @description
   * - 金额 ≤ 0 直接拒绝（90002），**绝不调用 FundService.credit**（避免脏写）；
   * - 账户冻结（status !== ACTIVE）→ 61003；
   * - 幂等键 = 充值单号，渠道重发不会重复加钱；
   * - 传了 `tx` → 在调用方事务内执行并把 `tx` 透传给 FundService.credit；
   *   没传 → 自开 `withTransaction`，保证「开户/取账户 + 写流水 + 改余额」原子。
   * @param userId 用户 ID
   * @param input 充值入参（金额 / 充值单号）
   * @param tx 事务客户端（不传则自开事务，label `balance.recharge`）
   * @returns 记账结果（FundResult）
   * @throws {ValidationError} 金额非正（90002）
   * @throws {BusinessError} 账户冻结（61003）
   */
  async creditByRecharge(userId: bigint, input: RechargeInput, tx?: TxClient) {
    // 金额红线：必须先拦，FundService.credit 一次都不该被调用
    if (MoneyUtil.toBigint(input.amount, 'amount') <= 0n) {
      throw new ValidationError('充值金额必须为正数（单位：分）', { code: ErrorCode.FIELD_FORMAT_INVALID });
    }

    const run = async (client: TxClient) => {
      // 解析账户（不存在则开户）；冻结账户拒绝入账
      const account = await this.fund.getOrCreateAccount(userId, FundAccountType.USER_BALANCE, client);
      if (account.status !== AccountStatus.ACTIVE) {
        throw new BusinessError('余额账户已冻结', { code: ErrorCode.BALANCE_ACCOUNT_FROZEN });
      }
      // 充值：用户余额账户入账（BALANCE_RECHARGE），幂等键 = 充值单号
      return this.fund.credit(
        {
          accountId: account.id,
          amount: input.amount,
          bizType: FundBizType.BALANCE_RECHARGE,
          idempotencyKey: input.rechargeNo,
          rechargeNo: input.rechargeNo,
          operatorType: OperatorType.USER,
          operatorId: userId,
        },
        client,
      );
    };

    if (tx !== undefined) {
      return run(tx);
    }
    // 未传 tx：自开事务，tx 透传给 FundService.credit（事务红线）
    return withTransaction((t) => run(t), { label: 'balance.recharge' });
  }
}

/** 默认单例（供 Controller 消费） */
export const balanceService = new BalanceService();
export default balanceService;
