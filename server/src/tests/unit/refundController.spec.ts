/**
 * @file server/src/tests/unit/refundController.spec.ts
 * @description T080-B 退款 HTTP 层控制器验收：资金安全分支（BALANCE 即时 SUCCESS /
 * CHANNEL 捕获 4104 置 FAILED 不 500 / 驳回不执行 / userId 边界）。
 * @module tests/unit
 * @see src/services/RefundService.ts（被 mock 的下层）、docs/04-flows.md F9
 * @author 软件开发团队
 * @created 2026-09-12
 *
 * 验收口径（沿用 T080-A 的「变异测试」精神，但作用在 HTTP 边界）：
 * 不验证「退款单被建出来」（那是 RefundService 单测的事），而是验证**控制器这层的
 * 资金安全决策点**——
 *   1. 同意 + 余额退款 → execute 成功 → 返回 SUCCESS（钱已退回余额）；
 *   2. 同意 + 渠道退款 → execute 抛 ExternalServiceError(4104) → 捕获后置 FAILED、返回 2xx 不 500；
 *   3. 驳回 → 只调 audit、绝不调 execute（不碰任何资金）；
 *   4. 非 4104 的异常（如并发 41003 / 平台账户缺失 60001）→ 原样向上抛，不静默吞掉；
 *   5. C 端 userId 只来自 req.auth（BigInt 转换），service 收到的 userId 与 token 一致。
 *
 * 用 `jest.mock('@/services/RefundService')` 把下层整体打桩，控制器逻辑独立可测、不依赖数据库。
 */

import { describe, expect, it, jest } from '@jest/globals';
import { ExternalServiceError, NotFoundError } from '@/core/errors';
import { ErrorCode } from '@/core/errors/errorCodes';
import { RefundStatus } from '@prisma/client';
import { refundController } from '@/controllers/RefundController';
import { adminRefundController } from '@/controllers/admin/AdminRefundController';
import { refundService } from '@/services/RefundService';

/**
 * 手动 mock 下层：只导出控制器用到的 `refundService` 单例桩，**不加载真实 RefundService 模块**
 * （真实模块会连带加载 `@/core/logger` → `@/config` → `parseEnv()`，在无 `.env` 的测试环境会
 * `process.exit(1)`）。下层记账 / 事务正确性由 `refundService.spec.ts` 单独验收，本文件只验证
 * 控制器层的资金安全决策点。
 */
jest.mock('@/services/RefundService', () => ({
  RefundService: class {},
  refundService: {
    apply: jest.fn(),
    audit: jest.fn(),
    execute: jest.fn(),
    getByNo: jest.fn(),
    listByUser: jest.fn(),
    markChannelFailed: jest.fn(),
  },
}));

/** 把被 mock 的 service 当作可编排的 jest.Mock 字典（测试桩，放宽类型） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const svc = refundService as any;

/** 构造一个最小可用的 Express res（捕获 sendOk/sendCreated 的输出） */
function makeRes() {
  const captured: { status?: number; body?: unknown } = {};
  const res = {
    req: { requestId: 'test-req' },
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(payload: unknown) {
      captured.body = payload;
      return res;
    },
  };
  return { res, captured };
}

/** 构造带 admin 作用域的 req（审核端点用） */
function adminReq(refundNo: string, body: unknown) {
  return {
    auth: { userId: 7, scope: 'admin', role: 'ADMIN', tokenVersion: 0 },
    params: { refundNo },
    body,
  } as unknown as import('express').Request;
}

/** 构造带 C 端 shop 作用域的 req（申请 / 列表 / 详情用） */
function shopReq(overrides: { params?: unknown; body?: unknown; query?: unknown } = {}) {
  return {
    auth: { userId: 42, scope: 'shop', role: 'USER', tokenVersion: 0 },
    params: overrides.params ?? {},
    body: overrides.body ?? {},
    query: overrides.query ?? {},
  } as unknown as import('express').Request;
}

/** 取响应体里的 data 字段 */
function dataOf(captured: { body?: unknown }): unknown {
  return (captured.body as { data?: unknown }).data;
}

describe('RefundController（C 端）', () => {
  it('apply：userId 只来自 req.auth（BigInt），返回 201 + {refundNo,status}', async () => {
    svc.apply.mockResolvedValue({ refundNo: 'R-100', status: RefundStatus.PENDING });
    const { res, captured } = makeRes();

    await refundController.apply(
      shopReq({ body: { orderNo: 'O-1', type: 'FULL', amount: 100n } }),
      res as never,
    );

    // userId 边界：service 收到的第一个参数必须是 BigInt(42)，不是字符串也不是别的
    expect(svc.apply).toHaveBeenCalledTimes(1);
    expect(svc.apply.mock.calls[0][0]).toBe(42n);
    expect(svc.apply.mock.calls[0][1]).toMatchObject({ orderNo: 'O-1', type: 'FULL', amount: 100n });
    expect(captured.status).toBe(201);
    expect(dataOf(captured)).toEqual({ refundNo: 'R-100', status: RefundStatus.PENDING });
  });

  it('detail：调 getByNo 并透传 userId 与 refundNo', async () => {
    const detail = { refundNo: 'R-100', status: RefundStatus.PROCESSING, items: [] };
    svc.getByNo.mockResolvedValue(detail);
    const { res, captured } = makeRes();

    await refundController.detail(shopReq({ params: { refundNo: 'R-100' } }), res as never);

    expect(svc.getByNo).toHaveBeenCalledWith(42n, 'R-100');
    expect(dataOf(captured)).toBe(detail);
  });

  it('list：调 listByUser 并透传分页参数', async () => {
    svc.listByUser.mockResolvedValue({ list: [{ refundNo: 'R-100' }], total: 1 });
    const { res, captured } = makeRes();

    await refundController.list(shopReq({ query: { page: 2, pageSize: 10 } }), res as never);

    expect(svc.listByUser).toHaveBeenCalledWith(42n, { page: 2, pageSize: 10 });
    expect(dataOf(captured)).toEqual({ list: [{ refundNo: 'R-100' }], total: 1 });
  });
});

describe('AdminRefundController.audit（审核 + 触发执行）', () => {
  it('驳回（approve=false）：只调 audit，绝不调 execute，返回 REJECTED', async () => {
    svc.audit.mockResolvedValue(undefined);
    const { res, captured } = makeRes();

    await adminRefundController.audit(adminReq('R-100', { approve: false, remark: '理由' }), res as never);

    expect(svc.audit).toHaveBeenCalledTimes(1);
    expect(svc.audit.mock.calls[0]).toEqual([7n, 'R-100', false, '理由']);
    expect(svc.execute).not.toHaveBeenCalled();
    expect(svc.markChannelFailed).not.toHaveBeenCalled();
    expect(dataOf(captured)).toEqual({ refundNo: 'R-100', status: RefundStatus.REJECTED });
  });

  it('同意 + 余额退款（execute 成功）：返回 SUCCESS，不标记 FAILED', async () => {
    svc.audit.mockResolvedValue(undefined);
    svc.execute.mockResolvedValue(undefined);
    const { res, captured } = makeRes();

    await adminRefundController.audit(adminReq('R-100', { approve: true }), res as never);

    expect(svc.audit).toHaveBeenCalledWith(7n, 'R-100', true, undefined);
    expect(svc.execute).toHaveBeenCalledWith('R-100');
    expect(svc.markChannelFailed).not.toHaveBeenCalled();
    expect(captured.status).toBe(200);
    expect(dataOf(captured)).toEqual({ refundNo: 'R-100', status: RefundStatus.SUCCESS });
  });

  it('同意 + 渠道退款（execute 抛 4104）：捕获后置 FAILED、返回 2xx 不 500', async () => {
    svc.audit.mockResolvedValue(undefined);
    svc.execute.mockRejectedValue(
      new ExternalServiceError('渠道退款未实现：一期缺少 PaymentAdapter', 'payment', 'channel', {
        code: ErrorCode.REFUND_EXEC_FAILED,
      }),
    );
    const { res, captured } = makeRes();

    // ⚠️ 不得抛出（否则 errorHandler 会归为 500），必须正常 resolve 并返回 FAILED
    await expect(
      adminRefundController.audit(adminReq('R-100', { approve: true }), res as never),
    ).resolves.toBeUndefined();

    expect(svc.markChannelFailed).toHaveBeenCalledTimes(1);
    expect(svc.markChannelFailed.mock.calls[0][0]).toBe('R-100');
    expect(captured.status).toBe(200);
    expect(dataOf(captured)).toEqual({ refundNo: 'R-100', status: RefundStatus.FAILED });
  });

  it('同意但 execute 抛非 4104 异常（如并发 41003）：原样向上抛，不静默吞掉', async () => {
    svc.audit.mockResolvedValue(undefined);
    svc.execute.mockRejectedValue(new NotFoundError('退款单不存在', { code: ErrorCode.REFUND_NOT_FOUND }));

    await expect(
      adminRefundController.audit(adminReq('R-100', { approve: true }), makeRes().res as never),
    ).rejects.toBeInstanceOf(NotFoundError);

    // 异常路径不应误标记 FAILED
    expect(svc.markChannelFailed).not.toHaveBeenCalled();
  });
});
