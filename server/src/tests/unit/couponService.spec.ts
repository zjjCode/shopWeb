/**
 * @file server/src/tests/unit/couponService.spec.ts
 * @description 优惠券服务单测：假 Prisma 驱动，覆盖领取（CAS/限领/状态）/列表/券优惠计算/下单解析/占用/核销/释放/返还
 * @module tests/unit
 * @see server/src/services/CouponService.ts、docs/04-flows.md F13 / F5.5 / F13.2
 * @author 软件开发团队
 * @created 2026-09-14
 *
 * 环境无 MySQL 实例，单测验证「代码走的是哪条路径、条件是否写对、写在哪一个 client 上」：
 * - 领取 CAS `issuedCount < totalCount` 失败时回滚并抛已领完；
 * - 占用 `UNUSED → LOCKED WHERE status='UNUSED'` affectedRows=0 即并发占用（12007）；
 * - 核销/释放/返还必须发生在传入的 tx 上（事务红线），且对无券订单 / 已终态幂等跳过。
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  CouponStatus,
  CouponTemplateStatus,
  CouponType,
  CouponValidType,
  ScopeType,
} from '@/constants/enums';
import { ErrorCode } from '@/core/errors/errorCodes';
import { withTransaction } from '@/core/transaction';
import { CouponService, type CouponTxClient } from '@/services/CouponService';

jest.mock('@/config', () => ({
  config: { env: 'test', redis: { keyPrefix: 'shop' }, log: { level: 'error', dir: '' } },
  isProduction: false,
  isTest: true,
  isDevelopment: false,
}));
jest.mock('@/core/prisma', () => ({ getPrisma: jest.fn(() => ({})) }));
jest.mock('@/core/transaction', () => ({ withTransaction: jest.fn() }));

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyAsyncFn = (...args: any[]) => Promise<any>;

/** 假委托：默认 client 与假 tx 各一套，互不共享 */
function makeDelegates(): any {
  return {
    coupon: {
      findUnique: jest.fn<AnyAsyncFn>(),
      findFirst: jest.fn<AnyAsyncFn>(),
      findMany: jest.fn<AnyAsyncFn>(),
      count: jest.fn<AnyAsyncFn>(),
      create: jest.fn<AnyAsyncFn>(),
      updateMany: jest.fn<AnyAsyncFn>(),
    },
    couponTemplate: {
      findUnique: jest.fn<AnyAsyncFn>(),
      updateMany: jest.fn<AnyAsyncFn>(),
    },
    couponUseLog: { create: jest.fn<AnyAsyncFn>() },
    orderCouponRecord: {
      create: jest.fn<AnyAsyncFn>(),
      findUnique: jest.fn<AnyAsyncFn>(),
      updateMany: jest.fn<AnyAsyncFn>(),
    },
    couponTemplateScope: { findMany: jest.fn<AnyAsyncFn>() },
    product: { findMany: jest.fn<AnyAsyncFn>() },
  };
}

let CLIENT: any;
let TX: any;
let svc: CouponService;

const USER_ID = 1001n;
const TEMPLATE = {
  id: 55n,
  templateNo: 'CT20260914000001',
  name: '满100减20',
  type: CouponType.FULL_REDUCE,
  thresholdAmount: 10000n,
  discountAmount: 2000n,
  discountRate: null,
  maxDiscount: null,
  validType: CouponValidType.FIXED_RANGE,
  validStart: null,
  validEnd: new Date('2026-12-31T23:59:59Z'),
  validDays: null,
  totalCount: 100,
  issuedCount: 0,
  perLimit: 1,
  scopeType: ScopeType.ALL,
  status: CouponTemplateStatus.CLAIMABLE,
};

beforeEach(() => {
  CLIENT = makeDelegates();
  TX = makeDelegates();
  svc = new CouponService(CLIENT);

  // 事务接管：执行闭包并传入假 tx
  (withTransaction as unknown as jest.Mock<AnyAsyncFn>).mockImplementation(
    async (fn: AnyAsyncFn) => fn(TX),
  );

  // 默认：模板可领取、未领过、券存在且 UNUSED
  CLIENT.couponTemplate.findUnique.mockResolvedValue({ ...TEMPLATE });
  CLIENT.coupon.count.mockResolvedValue(0);
  CLIENT.coupon.findMany.mockResolvedValue([]);
  CLIENT.couponTemplateScope.findMany.mockResolvedValue([]);
  CLIENT.product.findMany.mockResolvedValue([]);

  // 事务内默认成功
  TX.coupon.create.mockResolvedValue({ id: 1n, couponNo: 'CP20260914000000000001' });
  TX.coupon.updateMany.mockResolvedValue({ count: 1 });
  TX.couponTemplate.updateMany.mockResolvedValue({ count: 1 });
  TX.couponUseLog.create.mockResolvedValue({ id: 1n });
  TX.orderCouponRecord.create.mockResolvedValue({ id: 1n });
  TX.orderCouponRecord.findUnique.mockResolvedValue(null);
  TX.orderCouponRecord.updateMany.mockResolvedValue({ count: 1 });
});

describe('CouponService · 领取（事务 J，F13.1）', () => {
  it('正常领取：写券实例(UNUSED) + CAS issued_count+1 + 轨迹(CLAIM)', async () => {
    const res = await svc.claim(USER_ID, TEMPLATE.templateNo);

    expect(res.status).toBe(CouponStatus.UNUSED);
    expect(CLIENT.couponTemplate.findUnique).toHaveBeenCalledTimes(1);
    expect(CLIENT.coupon.count).toHaveBeenCalledTimes(1);
    expect(TX.coupon.create).toHaveBeenCalledTimes(1);
    expect(TX.couponUseLog.create).toHaveBeenCalledTimes(1);
    // 不限量模板（totalCount=null）不触发 CAS；此处 totalCount=100 → 触发 CAS
    expect(TX.couponTemplate.updateMany).toHaveBeenCalledTimes(1);
  });

  it('模板不存在 → COUPON_NOT_FOUND', async () => {
    CLIENT.couponTemplate.findUnique.mockResolvedValue(null);
    await expect(svc.claim(USER_ID, 'NOPE')).rejects.toMatchObject({ code: ErrorCode.COUPON_NOT_FOUND });
  });

  it('模板非 CLAIMABLE → COUPON_SOLD_OUT（暂不可领取）', async () => {
    CLIENT.couponTemplate.findUnique.mockResolvedValue({ ...TEMPLATE, status: CouponTemplateStatus.ENDED });
    await expect(svc.claim(USER_ID, TEMPLATE.templateNo)).rejects.toMatchObject({ code: ErrorCode.COUPON_SOLD_OUT });
  });

  it('超出限领 → COUPON_LIMIT_EXCEEDED', async () => {
    CLIENT.coupon.count.mockResolvedValue(TEMPLATE.perLimit);
    await expect(svc.claim(USER_ID, TEMPLATE.templateNo)).rejects.toMatchObject({ code: ErrorCode.COUPON_LIMIT_EXCEEDED });
  });

  it('CAS 并发领完（issued_count 已达上限）→ COUPON_SOLD_OUT 且券实例回滚不落库', async () => {
    TX.couponTemplate.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.claim(USER_ID, TEMPLATE.templateNo)).rejects.toMatchObject({ code: ErrorCode.COUPON_SOLD_OUT });
    expect(TX.coupon.create).toHaveBeenCalledTimes(1); // 已插入
    expect(TX.couponUseLog.create).not.toHaveBeenCalled(); // 回滚前不应写轨迹（事务回滚由 withTransaction 负责）
  });
});

describe('CouponService · 我的优惠券列表', () => {
  it('按状态 Tab 查询并返回摘要（含模板快照）', async () => {
    CLIENT.coupon.findMany.mockResolvedValue([
      {
        id: 1n,
        couponNo: 'CP1',
        templateId: TEMPLATE.id,
        status: CouponStatus.UNUSED,
        claimedAt: new Date('2026-09-14T00:00:00Z'),
        expireAt: new Date('2026-12-31T23:59:59Z'),
        template: { ...TEMPLATE },
      },
    ]);
    const list = await svc.listMy(USER_ID, { status: CouponStatus.UNUSED });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      couponId: 1n,
      couponNo: 'CP1',
      templateName: '满100减20',
      type: CouponType.FULL_REDUCE,
      thresholdAmount: 10000n,
      discountAmount: 2000n,
    });
    // 查询带 userId + 状态筛选
    expect(CLIENT.coupon.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { userId: USER_ID, status: CouponStatus.UNUSED },
    });
  });
});

describe('CouponService · 券优惠计算（computeDiscount）', () => {
  it('满减券：门槛内取面额，门槛外仍需上层拦截但返回面额', () => {
    const t = { type: CouponType.FULL_REDUCE, thresholdAmount: 10000n, discountAmount: 2000n, discountRate: null, maxDiscount: null };
    expect(svc.computeDiscount(t, 15000n)).toBe(2000n);
    expect(svc.computeDiscount(t, 5000n)).toBe(2000n); // 计算层仅返回面额，门槛由 resolveForOrder 拦截
  });

  it('折扣券：min(金额×rate/10000, 封顶)，且不超商品金额', () => {
    const t = { type: CouponType.DISCOUNT, thresholdAmount: 10000n, discountAmount: null, discountRate: 8500, maxDiscount: 3000n };
    expect(svc.computeDiscount(t, 20000n)).toBe(3000n); // 20000×0.85=17000 > 封顶3000 → 3000
    const t2 = { type: CouponType.DISCOUNT, thresholdAmount: 10000n, discountAmount: null, discountRate: 8500, maxDiscount: null };
    expect(svc.computeDiscount(t2, 20000n)).toBe(17000n);
  });

  it('无门槛券：恒取面额', () => {
    const t = { type: CouponType.NO_THRESHOLD, thresholdAmount: 0n, discountAmount: 1000n, discountRate: null, maxDiscount: null };
    expect(svc.computeDiscount(t, 500n)).toBe(500n); // 不超过商品金额
  });
});

describe('CouponService · 下单解析（resolveForOrder）', () => {
  const items = [{ skuId: 1n, productId: 10n, payableAmount: 15000n }];

  it('正常：返回券优惠额', async () => {
    CLIENT.coupon.findUnique.mockResolvedValue({
      id: 1n,
      userId: USER_ID,
      status: CouponStatus.UNUSED,
      expireAt: new Date('2099-01-01T00:00:00Z'),
      couponNo: 'CP1',
      template: { ...TEMPLATE },
    });
    const r = await svc.resolveForOrder(USER_ID, 1n, items);
    expect(r.discountAmount).toBe(2000n);
  });

  it('非本人券 → COUPON_NOT_FOUND', async () => {
    CLIENT.coupon.findUnique.mockResolvedValue({ id: 1n, userId: 999n, status: CouponStatus.UNUSED, expireAt: new Date('2099-01-01'), template: { ...TEMPLATE } });
    await expect(svc.resolveForOrder(USER_ID, 1n, items)).rejects.toMatchObject({ code: ErrorCode.COUPON_NOT_FOUND });
  });

  it('已占用(LOCKED) → COUPON_FROZEN', async () => {
    CLIENT.coupon.findUnique.mockResolvedValue({ id: 1n, userId: USER_ID, status: CouponStatus.LOCKED, expireAt: new Date('2099-01-01'), template: { ...TEMPLATE } });
    await expect(svc.resolveForOrder(USER_ID, 1n, items)).rejects.toMatchObject({ code: ErrorCode.COUPON_FROZEN });
  });

  it('已过期 → COUPON_EXPIRED', async () => {
    CLIENT.coupon.findUnique.mockResolvedValue({ id: 1n, userId: USER_ID, status: CouponStatus.UNUSED, expireAt: new Date('2020-01-01'), template: { ...TEMPLATE } });
    await expect(svc.resolveForOrder(USER_ID, 1n, items)).rejects.toMatchObject({ code: ErrorCode.COUPON_EXPIRED });
  });

  it('门槛未达 → COUPON_THRESHOLD_NOT_MET', async () => {
    CLIENT.coupon.findUnique.mockResolvedValue({ id: 1n, userId: USER_ID, status: CouponStatus.UNUSED, expireAt: new Date('2099-01-01'), template: { ...TEMPLATE } });
    await expect(svc.resolveForOrder(USER_ID, 1n, [{ skuId: 1n, productId: 10n, payableAmount: 5000n }])).rejects.toMatchObject({
      code: ErrorCode.COUPON_THRESHOLD_NOT_MET,
    });
  });

  it('适用范围不匹配(PRODUCT) → COUPON_NOT_APPLICABLE', async () => {
    CLIENT.coupon.findUnique.mockResolvedValue({
      id: 1n,
      userId: USER_ID,
      status: CouponStatus.UNUSED,
      expireAt: new Date('2099-01-01'),
      template: { ...TEMPLATE, scopeType: ScopeType.PRODUCT },
    });
    CLIENT.couponTemplateScope.findMany.mockResolvedValue([{ templateId: TEMPLATE.id, scopeType: ScopeType.PRODUCT, targetId: 999n }]);
    await expect(svc.resolveForOrder(USER_ID, 1n, [{ skuId: 1n, productId: 10n, payableAmount: 15000n }])).rejects.toMatchObject({
      code: ErrorCode.COUPON_NOT_APPLICABLE,
    });
  });
});

describe('CouponService · 下单占用（lockForOrder / bindForOrder，必传 tx）', () => {
  const lockInput = { orderNo: 'SO20260914000001', discountAmount: 2000n };
  const bindInput = { orderId: 7n, orderNo: 'SO20260914000001', discountAmount: 2000n };

  it('lockForOrder：UNUSED→LOCKED + 轨迹，不写券记录、全走 tx（不碰默认 client）', async () => {
    TX.coupon.findUnique.mockResolvedValue({ id: 1n, userId: USER_ID, couponNo: 'CP1', templateId: TEMPLATE.id, template: { ...TEMPLATE } });
    await svc.lockForOrder(1n, USER_ID, lockInput, TX as CouponTxClient);

    expect(TX.coupon.updateMany).toHaveBeenCalledTimes(1);
    expect(TX.coupon.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: 1n, userId: USER_ID, status: CouponStatus.UNUSED },
      data: { status: CouponStatus.LOCKED },
    });
    expect(TX.couponUseLog.create).toHaveBeenCalledTimes(1);
    expect(TX.orderCouponRecord.create).not.toHaveBeenCalled(); // 建单前不写记录
    expect(CLIENT.coupon.updateMany).not.toHaveBeenCalled(); // 红线：没退回默认 client
  });

  it('lockForOrder 并发占用（affectedRows=0）→ COUPON_FROZEN', async () => {
    TX.coupon.findUnique.mockResolvedValue({ id: 1n, userId: USER_ID, couponNo: 'CP1', templateId: TEMPLATE.id, template: { ...TEMPLATE } });
    TX.coupon.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.lockForOrder(1n, USER_ID, lockInput, TX as CouponTxClient)).rejects.toMatchObject({
      code: ErrorCode.COUPON_FROZEN,
    });
  });

  it('lockForOrder 非本人券 → COUPON_NOT_FOUND', async () => {
    TX.coupon.findUnique.mockResolvedValue({ id: 1n, userId: 999n, couponNo: 'CP1', templateId: TEMPLATE.id, template: { ...TEMPLATE } });
    await expect(svc.lockForOrder(1n, USER_ID, lockInput, TX as CouponTxClient)).rejects.toMatchObject({ code: ErrorCode.COUPON_NOT_FOUND });
  });

  it('bindForOrder：写券记录（含快照）并关联 orderId，全走 tx', async () => {
    TX.coupon.findUnique.mockResolvedValue({
      id: 1n,
      userId: USER_ID,
      couponNo: 'CP1',
      templateId: TEMPLATE.id,
      status: CouponStatus.LOCKED,
      template: { ...TEMPLATE },
    });
    await svc.bindForOrder(1n, USER_ID, bindInput, TX as CouponTxClient);

    expect(TX.orderCouponRecord.create).toHaveBeenCalledTimes(1);
    const recordArg = TX.orderCouponRecord.create.mock.calls[0]?.[0] as {
      data: { orderId: bigint; orderNo: string; couponId: bigint; discountAmount: bigint; snapshot: { name: string } };
    };
    expect(recordArg.data.orderId).toBe(7n);
    expect(recordArg.data.orderNo).toBe('SO20260914000001');
    expect(recordArg.data.couponId).toBe(1n);
    expect(recordArg.data.discountAmount).toBe(2000n);
    expect(recordArg.data.snapshot.name).toBe('满100减20');
    expect(CLIENT.orderCouponRecord.create).not.toHaveBeenCalled(); // 红线：没退回默认 client
  });

  it('bindForOrder 券不存在 → 幂等跳过（零写）', async () => {
    TX.coupon.findUnique.mockResolvedValue(null);
    await svc.bindForOrder(1n, USER_ID, bindInput, TX as CouponTxClient);
    expect(TX.orderCouponRecord.create).not.toHaveBeenCalled();
  });
});

describe('CouponService · 支付核销（markUsedByOrderNo，必传 tx）', () => {
  it('LOCKED→USED + used_count+1 + 轨迹，全走 tx', async () => {
    TX.orderCouponRecord.findUnique.mockResolvedValue({ orderNo: 'SO1', couponId: 1n, templateId: TEMPLATE.id });
    TX.coupon.findUnique.mockResolvedValue({ id: 1n, couponNo: 'CP1', status: CouponStatus.LOCKED });
    await svc.markUsedByOrderNo('SO1', TX as CouponTxClient);

    expect(TX.coupon.updateMany).toHaveBeenCalledTimes(1);
    expect(TX.coupon.updateMany.mock.calls[0]?.[0].data.status).toBe(CouponStatus.USED);
    expect(TX.couponTemplate.updateMany).toHaveBeenCalledTimes(1);
    expect(TX.couponUseLog.create).toHaveBeenCalledTimes(1);
  });

  it('无券订单 → 幂等跳过（零写）', async () => {
    TX.orderCouponRecord.findUnique.mockResolvedValue(null);
    await svc.markUsedByOrderNo('SO1', TX as CouponTxClient);
    expect(TX.coupon.updateMany).not.toHaveBeenCalled();
    expect(TX.couponUseLog.create).not.toHaveBeenCalled();
  });

  it('已核销 → 幂等跳过', async () => {
    TX.orderCouponRecord.findUnique.mockResolvedValue({ orderNo: 'SO1', couponId: 1n, templateId: TEMPLATE.id });
    TX.coupon.findUnique.mockResolvedValue({ id: 1n, couponNo: 'CP1', status: CouponStatus.USED });
    await svc.markUsedByOrderNo('SO1', TX as CouponTxClient);
    expect(TX.coupon.updateMany).not.toHaveBeenCalled();
  });
});

describe('CouponService · 取消/关单解冻（releaseByOrderNo，必传 tx）', () => {
  it('LOCKED→UNUSED 解冻 + 轨迹，全走 tx', async () => {
    TX.orderCouponRecord.findUnique.mockResolvedValue({ orderNo: 'SO1', couponId: 1n, templateId: TEMPLATE.id });
    TX.coupon.findUnique.mockResolvedValue({ id: 1n, couponNo: 'CP1', status: CouponStatus.LOCKED });
    await svc.releaseByOrderNo('SO1', TX as CouponTxClient);

    expect(TX.coupon.updateMany).toHaveBeenCalledTimes(1);
    expect(TX.coupon.updateMany.mock.calls[0]?.[0].data.status).toBe(CouponStatus.UNUSED);
    expect(TX.couponUseLog.create).toHaveBeenCalledTimes(1);
  });

  it('已解冻/无券 → 幂等跳过', async () => {
    TX.orderCouponRecord.findUnique.mockResolvedValue(null);
    await svc.releaseByOrderNo('SO1', TX as CouponTxClient);
    expect(TX.coupon.updateMany).not.toHaveBeenCalled();
  });

  it('已支付(USED) 不在本链路解冻', async () => {
    TX.orderCouponRecord.findUnique.mockResolvedValue({ orderNo: 'SO1', couponId: 1n, templateId: TEMPLATE.id });
    TX.coupon.findUnique.mockResolvedValue({ id: 1n, couponNo: 'CP1', status: CouponStatus.USED });
    await svc.releaseByOrderNo('SO1', TX as CouponTxClient);
    expect(TX.coupon.updateMany).not.toHaveBeenCalled();
  });
});

describe('CouponService · 整单退款返还（restoreByOrderNo，必传 tx）', () => {
  it('USED→UNUSED + 回写 restored + 轨迹，全走 tx', async () => {
    TX.orderCouponRecord.findUnique.mockResolvedValue({ orderNo: 'SO1', couponId: 1n, templateId: TEMPLATE.id });
    TX.coupon.findUnique.mockResolvedValue({ id: 1n, couponNo: 'CP1', status: CouponStatus.USED });
    await svc.restoreByOrderNo('SO1', 'SR1', TX as CouponTxClient);

    expect(TX.coupon.updateMany).toHaveBeenCalledTimes(1);
    expect(TX.coupon.updateMany.mock.calls[0]?.[0].data.status).toBe(CouponStatus.UNUSED);
    expect(TX.orderCouponRecord.updateMany).toHaveBeenCalledTimes(1);
    expect(TX.couponUseLog.create).toHaveBeenCalledTimes(1);
    expect(TX.couponUseLog.create.mock.calls[0]?.[0].data.refundNo).toBe('SR1');
  });

  it('非已核销/无券 → 幂等跳过', async () => {
    TX.orderCouponRecord.findUnique.mockResolvedValue(null);
    await svc.restoreByOrderNo('SO1', 'SR1', TX as CouponTxClient);
    expect(TX.coupon.updateMany).not.toHaveBeenCalled();
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
