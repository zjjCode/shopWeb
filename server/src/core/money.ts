/**
 * @file server/src/money.ts
 * @description 金额工具 MoneyUtil：全链路以「分」为单位的 bigint 运算与按权重分摊
 * @module core
 * @see docs/02-architecture.md §5.11（金额处理公约与恒等式 E1~E10）
 * @see docs/03-database.md §1.2（金额字段公约）
 * @author 软件开发团队
 * @created 2026-09-03
 */

import { BusinessError, ValidationError } from '@/core/errors';
import { ErrorCode } from '@/core/errors/errorCodes';

/** 金额入参类型：允许 number（分）或 bigint（Prisma 直读） */
export type MoneyInput = number | bigint;

/**
 * 金额工具集。
 *
 * 三条铁律：
 * 1. **单位恒为「分」**，永不出现小数金额字段（§5.11）；
 * 2. **内部一律 bigint 运算**，只在出入边界转成 number（安全整数范围内无损）；
 * 3. **分摊必走 allocate**，尾差计入权重最大项，保证恒等式 E3 严格成立。
 */
export class MoneyUtil {
  /** JS 安全整数上限（分）：9,007,199,254,740,991 分 ≈ 90 万亿元 */
  private static readonly MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

  /** 万分比基数：8500 表示 85 折 */
  static readonly PERCENT_BASE = 10_000;

  /**
   * 把入参统一转成 bigint（内部运算的唯一表示）。
   *
   * @param value 金额（分）
   * @param field 字段名，用于错误提示定位
   * @returns bigint 金额
   * @throws {ValidationError} 非安全整数时抛出（code 90002）
   */
  static toBigint(value: MoneyInput, field = 'amount'): bigint {
    if (typeof value === 'bigint') {
      return value;
    }
    if (typeof value === 'number' && Number.isSafeInteger(value)) {
      return BigInt(value);
    }
    throw new ValidationError(`字段 ${field} 必须是安全整数（单位：分）`, {
      code: ErrorCode.FIELD_FORMAT_INVALID,
      data: { errors: [{ field, message: '必须是安全整数（单位：分）', code: ErrorCode.FIELD_FORMAT_INVALID }] },
    });
  }

  /**
   * 断言金额合法并返回 number。
   *
   * @description 校验规则与 §5.11 一致：`Number.isSafeInteger(v) && v >= 0`，
   * 不满足直接抛错 —— 金额是资金系统的地基，宁可拒绝请求也不能带着脏数据进事务
   * @param value 待校验的值
   * @param field 字段名
   * @returns 校验通过的金额（分，number）
   * @throws {ValidationError} 非法金额
   */
  static assertAmount(value: unknown, field = 'amount'): number {
    if (typeof value === 'bigint') {
      const asNumber = Number(value);
      if (!Number.isSafeInteger(asNumber) || asNumber < 0) {
        throw new ValidationError(`字段 ${field} 金额不合法`, {
          code: ErrorCode.FIELD_FORMAT_INVALID,
          data: { errors: [{ field, message: '金额必须是非负安全整数（单位：分）', code: ErrorCode.FIELD_FORMAT_INVALID }] },
        });
      }
      return asNumber;
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new ValidationError(`字段 ${field} 金额不合法`, {
        code: ErrorCode.FIELD_FORMAT_INVALID,
        data: { errors: [{ field, message: '金额必须是非负安全整数（单位：分）', code: ErrorCode.FIELD_FORMAT_INVALID }] },
      });
    }
    return value;
  }

  /**
   * bigint 结果转回 number，并校验未超出安全整数范围。
   *
   * @param value bigint 金额
   * @param field 字段名
   * @returns number 金额（分）
   * @throws {ValidationError} 超出安全整数范围
   */
  private static toNumber(value: bigint, field = 'amount'): number {
    if (value > MoneyUtil.MAX_SAFE_BIGINT || value < -MoneyUtil.MAX_SAFE_BIGINT) {
      throw new ValidationError(`字段 ${field} 金额超出安全整数范围`, {
        code: ErrorCode.FIELD_FORMAT_INVALID,
        data: { errors: [{ field, message: '金额超出安全整数范围', code: ErrorCode.FIELD_FORMAT_INVALID }] },
      });
    }
    return Number(value);
  }

  /**
   * 加法。
   *
   * @param a 金额一（分）
   * @param b 金额二（分）
   * @returns 和（分）
   */
  static add(a: MoneyInput, b: MoneyInput): number {
    const result = MoneyUtil.toBigint(a, 'a') + MoneyUtil.toBigint(b, 'b');
    return MoneyUtil.toNumber(result, 'a+b');
  }

  /**
   * 减法。
   *
   * @description **允许负数结果**（如「可退金额 = 实付 - 已退」在并发边界可能为负的中间值），
   * 需要非负保证的场景请自行调用 {@link assertAmount}
   * @param a 被减数（分）
   * @param b 减数（分）
   * @returns 差（分）
   */
  static subtract(a: MoneyInput, b: MoneyInput): number {
    const result = MoneyUtil.toBigint(a, 'a') - MoneyUtil.toBigint(b, 'b');
    return MoneyUtil.toNumber(result, 'a-b');
  }

  /**
   * 乘法（金额 × 整数倍率，如数量）。
   *
   * @param amount 金额（分）
   * @param factor 整数倍率（数量、天数等）
   * @returns 积（分）
   * @throws {ValidationError} 倍率不是安全整数时抛出
   */
  static multiply(amount: MoneyInput, factor: MoneyInput): number {
    if (typeof factor === 'number' && !Number.isSafeInteger(factor)) {
      throw new ValidationError('倍率必须是安全整数', {
        code: ErrorCode.FIELD_FORMAT_INVALID,
      });
    }
    const result = MoneyUtil.toBigint(amount, 'amount') * MoneyUtil.toBigint(factor, 'factor');
    return MoneyUtil.toNumber(result, 'amount*factor');
  }

  /**
   * 除法（四舍五入 half-up）。
   *
   * @description 用于比例换算；金额分摊请优先用 {@link allocate}（保证总和守恒）
   * @param amount 被除数（分）
   * @param divisor 除数（正整数）
   * @returns 商（分）
   * @throws {ValidationError} 除数为 0 或非整数
   */
  static divide(amount: MoneyInput, divisor: MoneyInput): number {
    const divisorBigint = MoneyUtil.toBigint(divisor, 'divisor');
    if (divisorBigint === 0n) {
      throw new ValidationError('除数不能为 0', { code: ErrorCode.FIELD_FORMAT_INVALID });
    }
    const amountBigint = MoneyUtil.toBigint(amount, 'amount');
    const negative = amountBigint < 0n !== divisorBigint < 0n;
    const absAmount = amountBigint < 0n ? -amountBigint : amountBigint;
    const absDivisor = divisorBigint < 0n ? -divisorBigint : divisorBigint;
    // 四舍五入：(a + d/2) / d，向下取整后再补符号
    const quotient = (absAmount * 2n + absDivisor) / (absDivisor * 2n);
    return MoneyUtil.toNumber(negative ? -quotient : quotient, 'amount/divisor');
  }

  /**
   * 按万分比计算金额（四舍五入 half-up）。
   *
   * @description 85 折 = rateBp 8500，即 `applyRate(10000, 8500) = 8500`
   * @param amount 金额（分）
   * @param rateBp 万分比整数（0 ~ 10000）
   * @returns 计算后的金额（分）
   * @throws {ValidationError} rateBp 非法
   */
  static applyRate(amount: MoneyInput, rateBp: number): number {
    if (!Number.isSafeInteger(rateBp) || rateBp < 0) {
      throw new ValidationError('万分比必须是非负整数', { code: ErrorCode.PROMOTION_RULE_INVALID });
    }
    const amountBigint = MoneyUtil.toBigint(amount, 'amount');
    const base = BigInt(MoneyUtil.PERCENT_BASE);
    // (amount * rate + base/2) / base —— 分子加半个除数实现四舍五入
    const result = (amountBigint * BigInt(rateBp) + base / 2n) / base;
    return MoneyUtil.toNumber(result, 'amount*rate');
  }

  /**
   * 按折扣率计算优惠额（金额 - 折后金额）。
   *
   * @description 85 折时 `discountByRate(10000, 8500) = 1500`
   * @param amount 金额（分）
   * @param rateBp 万分比折扣率
   * @returns 优惠额（分）
   */
  static discountByRate(amount: MoneyInput, rateBp: number): number {
    const original = MoneyUtil.toBigint(amount, 'amount');
    const discounted = BigInt(MoneyUtil.applyRate(original, rateBp));
    return MoneyUtil.toNumber(original - discounted, 'discount');
  }

  /**
   * 求和。
   *
   * @param values 金额数组
   * @returns 总和（分）
   */
  static sum(values: readonly MoneyInput[]): number {
    const total = values.reduce<bigint>(
      (acc, value, index) => acc + MoneyUtil.toBigint(value, `values[${index}]`),
      0n,
    );
    return MoneyUtil.toNumber(total, 'sum');
  }

  /**
   * 比较两个金额。
   *
   * @param a 金额一
   * @param b 金额二
   * @returns a > b 返回 1，a < b 返回 -1，相等返回 0
   */
  static compare(a: MoneyInput, b: MoneyInput): -1 | 0 | 1 {
    const bigA = MoneyUtil.toBigint(a, 'a');
    const bigB = MoneyUtil.toBigint(b, 'b');
    if (bigA > bigB) return 1;
    if (bigA < bigB) return -1;
    return 0;
  }

  /**
   * 判断是否相等。
   *
   * @param a 金额一
   * @param b 金额二
   * @returns 是否相等
   */
  static equals(a: MoneyInput, b: MoneyInput): boolean {
    return MoneyUtil.toBigint(a, 'a') === MoneyUtil.toBigint(b, 'b');
  }

  /** 取较大值 */
  static max(a: MoneyInput, b: MoneyInput): number {
    return MoneyUtil.compare(a, b) >= 0 ? MoneyUtil.toNumber(MoneyUtil.toBigint(a), 'a') : MoneyUtil.toNumber(MoneyUtil.toBigint(b), 'b');
  }

  /** 取较小值 */
  static min(a: MoneyInput, b: MoneyInput): number {
    return MoneyUtil.compare(a, b) <= 0 ? MoneyUtil.toNumber(MoneyUtil.toBigint(a), 'a') : MoneyUtil.toNumber(MoneyUtil.toBigint(b), 'b');
  }

  /**
   * 把金额限制在 [min, max] 区间内。
   *
   * @description 典型用途：优惠额 clamp 到商品金额（恒等式 E5）
   * @param value 金额（分）
   * @param min 下限
   * @param max 上限
   * @returns 限制后的金额（分）
   */
  static clamp(value: MoneyInput, min: MoneyInput, max: MoneyInput): number {
    const bigValue = MoneyUtil.toBigint(value, 'value');
    const bigMin = MoneyUtil.toBigint(min, 'min');
    const bigMax = MoneyUtil.toBigint(max, 'max');
    if (bigValue < bigMin) return MoneyUtil.toNumber(bigMin, 'clamped');
    if (bigValue > bigMax) return MoneyUtil.toNumber(bigMax, 'clamped');
    return MoneyUtil.toNumber(bigValue, 'clamped');
  }

  // --------------------------------------------------------------------------
  // 分摊算法
  // --------------------------------------------------------------------------

  /**
   * 按权重分摊总额，返回 bigint 数组（尾差计入权重最大项，并按行权重截断）。
   *
   * 算法（docs/03-database.md §3.4 CPN-13，**五步缺一不可**）：
   * 1. **权重**：`weight_i = goodsAmount_i - promoDiscount_i`（促销后行金额）。
   *    由调用方按此公式算好再传入，本方法只做分摊不猜业务语义 ——
   *    分摊的是**订单级优惠**（订单级满减 + 优惠券），行级促销天然归行不参与；
   * 2. **向下取整**：`share_i = floor(total * w_i / Σw)`。向下取整保证单项不会超过应得份额，
   *    累计产生的尾差恒为**非负整数**，可以直接补回去，不会出现"多扣 1 分"；
   * 3. **尾差计入权重最大项**：`remainder = total - Σshare_i`（范围 `[0, n-1]`），
   *    逐分加到权重最大的那一行（权重相同时取下标最小者，保证结果可复现）。
   *    规范选择「集中到最大项」而不是「按小数部分分散补齐」，是为了让分摊结果**稳定可复现** ——
   *    部分退款重算时必须得到与下单时完全一致的每行分摊额，否则 E3/E9 会漂；
   * 4. **截断**：若 `share_i > weight_i` 则 `share_i = weight_i`，被截断的金额按第 3 步规则
   *    补给其它**仍有容量**的行。这一步是行内守恒
   *    （`promo + allocated <= goods`，§3.4 约束 ④）的唯一保障 ——
   *    缺少它时，`total > Σw`（优惠力度大于可分摊金额）或尾差集中砸向同一行的场景下，
   *    单行分摊额会超过该行商品金额，直接把行实付算成负数；
   * 5. **守恒保证**：`Σ(返回结果) === total` 严格成立，这是恒等式 E3 的前提，
   *    也是「一单多件退一件」能算清该退多少的唯一依据。
   *    结果固化到 `order_items.allocated_discount` 后，**退款时只读不重算**。
   *
   * 边界：
   * - `weights` 为空数组且 `total === 0` → 返回空数组；`total !== 0` → 抛错（无处安放的金额）；
   * - `Σw === 0` 或 `total === 0` → 全额落在第一项（或全 0），不产生漂移；
   * - 截断后仍有分不出去的金额（说明 `total > Σw`）→ 抛错，由调用方 clamp 优惠额后重试。
   *
   * @param total 待分摊总额（分，非负）
   * @param weights 权重数组（各行 `促销后行金额`，非负）
   * @returns 分摊结果（bigint，单位分），长度与 weights 一致、逐项 ≤ 权重且和恒等于 total
   * @throws {ValidationError} 入参非法、总额为负，或金额超出各行权重上限
   */
  static allocateBigint(total: MoneyInput, weights: readonly MoneyInput[]): bigint[] {
    const totalBigint = MoneyUtil.toBigint(total, 'total');
    if (totalBigint < 0n) {
      throw new ValidationError('待分摊总额不能为负数', { code: ErrorCode.ORDER_AMOUNT_INVALID });
    }

    const weightList = weights.map((weight, index) => {
      const value = MoneyUtil.toBigint(weight, `weights[${index}]`);
      if (value < 0n) {
        throw new ValidationError(`权重 weights[${index}] 不能为负数`, { code: ErrorCode.ORDER_AMOUNT_INVALID });
      }
      return value;
    });

    if (weightList.length === 0) {
      if (totalBigint === 0n) {
        return [];
      }
      throw new ValidationError('权重数组为空，无法分摊非零金额', { code: ErrorCode.ORDER_AMOUNT_INVALID });
    }

    if (totalBigint === 0n) {
      return weightList.map(() => 0n);
    }

    const totalWeight = weightList.reduce((acc, weight) => acc + weight, 0n);
    if (totalWeight === 0n) {
      // 权重全为 0（例如赠送行）：全额落在第一项，宁可集中也不允许金额丢失
      const fallback = weightList.map(() => 0n);
      fallback[0] = totalBigint;
      return fallback;
    }

    // 步骤 2：逐行向下取整
    const shares = weightList.map((weight) => (totalBigint * weight) / totalWeight);
    const allocated = shares.reduce((acc, share) => acc + share, 0n);

    // 步骤 3 + 4：先回收超权重的行，再把尾差按「权重最大优先」补进仍有容量的行
    const undistributed = MoneyUtil.distributeRemainder(shares, weightList, totalBigint - allocated);

    if (undistributed > 0n) {
      // 能走到这里说明 total > Σw：优惠力度已经超过全部订单行可承受的上限，
      // 继续分摊会把某一行算成负实付（违反 §3.4 约束 ④），必须让调用方 clamp 后重试
      throw new ValidationError('待分摊金额超出各行权重上限，请先将优惠额限制在商品金额内', {
        code: ErrorCode.ORDER_AMOUNT_INVALID,
        data: {
          total: MoneyUtil.toNumber(totalBigint, 'total'),
          totalWeight: MoneyUtil.toNumber(totalWeight, 'totalWeight'),
          undistributed: MoneyUtil.toNumber(undistributed, 'undistributed'),
        },
      });
    }

    return shares;
  }

  /**
   * 尾差分配 + 超权重截断（分摊算法第 3、4 步，原地修改 `shares`）。
   *
   * 为什么两步必须合并执行：
   * 第 3 步把尾差补到「权重最大」的行，若该行容量已满（例如 `total > Σw` 的过度优惠场景，
   * 或尾差集中砸向同一行的场景），单纯累加会让 `share_i > weight_i`，
   * 直接违反行内守恒（`promo + allocated <= goods`，§3.4 约束 ④）。
   * 因此每一次补充都必须按**剩余容量**截断，被截下来的金额回流到 remainder 继续分配，
   * 直到分完或无处可放为止。
   *
   * @description 实现要点：一次补 `min(remainder, capacity)` 而不是 1 分 1 分地补，
   * 把循环轮次从 O(金额) 降到 O(行数)，避免大额分摊把 CPU 打满
   * @param shares 分摊结果（原地修改）
   * @param weights 各行权重（同时是每行的可分摊上限）
   * @param remainder 待补的尾差（分，非负）
   * @returns 分不出去的余额（0n 表示已全部分配完毕）
   */
  private static distributeRemainder(shares: bigint[], weights: readonly bigint[], remainder: bigint): bigint {
    let pending = remainder;

    // 第 4 步第一轮：回收本身就已超权重的行（total > Σw 时必然出现）
    for (let i = 0; i < shares.length; i += 1) {
      const share = shares[i] ?? 0n;
      const weight = weights[i] ?? 0n;
      if (share > weight) {
        shares[i] = weight;
        pending += share - weight;
      }
    }

    while (pending > 0n) {
      let target = -1;
      for (let i = 0; i < shares.length; i += 1) {
        const capacity = (weights[i] ?? 0n) - (shares[i] ?? 0n);
        if (capacity <= 0n) {
          continue;
        }
        if (target === -1) {
          target = i;
          continue;
        }
        // 权重并列时保留行号较小者：只有严格大于才替换，保证结果可复现
        if ((weights[i] ?? 0n) > (weights[target] ?? 0n)) {
          target = i;
        }
      }

      if (target === -1) {
        // 所有行都已满：剩下的金额无处安放，交由调用方决定（抛错 / clamp 后重试）
        break;
      }

      const capacity = (weights[target] ?? 0n) - (shares[target] ?? 0n);
      const chunk = pending < capacity ? pending : capacity;
      shares[target] = (shares[target] ?? 0n) + chunk;
      pending -= chunk;
    }

    return pending;
  }

  /**
   * 按权重分摊总额（number 版本）。
   *
   * @description 与 {@link allocateBigint} 同算法，仅出入参类型不同；
   * 保证 `MoneyUtil.sum(结果) === total` 严格成立（恒等式 E3）
   * @param total 待分摊总额（分，非负）
   * @param weights 权重数组（各行 `price × quantity`，非负）
   * @returns 分摊结果（number，单位分）
   * @throws {ValidationError} 入参非法
   */
  static allocate(total: MoneyInput, weights: readonly MoneyInput[]): number[] {
    return MoneyUtil.allocateBigint(total, weights).map((share) => MoneyUtil.toNumber(share, 'allocated'));
  }

  // --------------------------------------------------------------------------
  // 展示与转换
  // --------------------------------------------------------------------------

  /**
   * 分 → 元（number）。
   *
   * @description 仅用于**展示与导出**，禁止把结果再回传参与计算（§5.11 反模式警告）
   * @param cents 金额（分）
   * @returns 元
   */
  static toYuan(cents: MoneyInput): number {
    return MoneyUtil.toNumber(MoneyUtil.toBigint(cents, 'cents'), 'cents') / 100;
  }

  /**
   * 元 → 分（number）。
   *
   * @description 用于后台表单录入（运营习惯填元）；先转字符串再计算，避免浮点误差（0.1 + 0.2 问题）
   * @param yuan 元（最多两位小数）
   * @returns 分
   * @throws {ValidationError} 小数位超过 2 位或不是有限数
   */
  static fromYuan(yuan: number | string): number {
    const text = typeof yuan === 'number' ? yuan.toString() : yuan.trim();
    if (!/^-?\d+(\.\d{1,2})?$/.test(text)) {
      throw new ValidationError('金额格式不正确（元，最多两位小数）', { code: ErrorCode.FIELD_FORMAT_INVALID });
    }
    const negative = text.startsWith('-');
    const absolute = negative ? text.slice(1) : text;
    const [integerPart = '0', decimalPart = ''] = absolute.split('.');
    const cents = BigInt(integerPart) * 100n + BigInt((decimalPart + '00').slice(0, 2));
    return MoneyUtil.toNumber(negative ? -cents : cents, 'cents');
  }

  /**
   * 格式化为带货币符号的展示文本。
   *
   * @param cents 金额（分）
   * @param options.withSymbol 是否带 ¥ 前缀，默认 true
   * @param options.thousands 是否千分位分隔，默认 true
   * @returns 展示文本，如 `¥1,234.56`
   */
  static format(cents: MoneyInput, options: { withSymbol?: boolean; thousands?: boolean } = {}): string {
    const { withSymbol = true, thousands = true } = options;
    const value = MoneyUtil.toNumber(MoneyUtil.toBigint(cents, 'cents'), 'cents');
    const negative = value < 0;
    const absolute = Math.abs(value);
    const integerPart = Math.floor(absolute / 100).toString();
    const decimalPart = (absolute % 100).toString().padStart(2, '0');
    const formattedInteger = thousands ? integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : integerPart;
    return `${negative ? '-' : ''}${withSymbol ? '¥' : ''}${formattedInteger}.${decimalPart}`;
  }

  // --------------------------------------------------------------------------
  // 恒等式断言
  // --------------------------------------------------------------------------

  /**
   * 断言金额恒等式成立。
   *
   * @description E1~E10 的统一入口，任一恒等式不成立立即抛错拒绝下单，
   * 绝不允许带着算错的金额进入事务（§5.11）
   * @param identity 恒等式编号，如 `E3`
   * @param left 左值（分）
   * @param right 右值（分）
   * @param detail 断言上下文（便于排查，如订单号、各行金额）
   * @throws {BusinessError} 恒等式不成立（code 31003 订单金额校验失败）
   */
  static assertIdentity(identity: string, left: MoneyInput, right: MoneyInput, detail: unknown = null): void {
    const bigLeft = MoneyUtil.toBigint(left, `${identity}.left`);
    const bigRight = MoneyUtil.toBigint(right, `${identity}.right`);
    if (bigLeft !== bigRight) {
      throw new BusinessError(`金额恒等式 ${identity} 校验失败`, {
        code: ErrorCode.ORDER_AMOUNT_INVALID,
        data: {
          identity,
          left: MoneyUtil.toNumber(bigLeft, 'left'),
          right: MoneyUtil.toNumber(bigRight, 'right'),
          diff: MoneyUtil.toNumber(bigLeft - bigRight, 'diff'),
          detail,
        },
      });
    }
  }
}

export default MoneyUtil;
