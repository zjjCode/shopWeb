/**
 * @file server/src/app.ts
 * @description Express 应用装配：按 §5.5 固定顺序注册中间件（不含 listen，便于测试复用）
 * @module app
 * @see docs/02-architecture.md §5.5（中间件执行顺序）
 * @author 软件开发团队
 * @created 2026-09-04
 *
 * 为什么 app 与 listen 必须分离：
 * `supertest` 需要直接拿到 `Application` 实例发起请求，若 `listen` 写在模块顶层，
 * 一 import 就会占用端口并在测试结束后悬挂进程。因此这里只装配、不监听，
 * 端口监听交给 `server.ts`（§5.5 的「启动入口」职责）。
 *
 * 中间件顺序（严格对照 §5.5 顺序表，**不可随意调整**）：
 * | # | 中间件 | 说明 |
 * | --- | --- | --- |
 * | 1 | requestId | 必须在最前，否则后续日志没有链路 ID |
 * | 2 | httpLog | 请求进入日志；响应日志挂在其 finish 钩子上 |
 * | 3 | cors | 非白名单直接 403（统一格式） |
 * | 4 | security | helmet + hpp；体大小限制 |
 * | 5 | globalRateLimit | 全局 + IP 维度兜底（**先于 bodyParser**，超限请求不解析 body） |
 * | 6 | bodyParser | json + urlencoded，**保留 rawBody** 供回调验签 |
 * | 7~11 | auth / adminOnly / validate / idempotency / pagination | 路由级，按需挂载 |
 * | 12 | Controller | 业务处理（T005+ 各业务模块路由在此挂载） |
 * | 13 | notFound | 兜底 → 90003 |
 * | 14 | errorHandler | **必须最后注册** |
 */

import express, { type Application, type Router } from 'express';
import { config } from '@/config';
import { isPrismaHealthy } from '@/core/prisma';
import { isRedisAvailable } from '@/core/redis';
import { jsonReplacer, sendOk } from '@/core/response';
import { asyncHandler } from '@/middlewares/asyncHandler';
import { bodyParser } from '@/middlewares/bodyParser';
import { cors } from '@/middlewares/cors';
import { errorHandler } from '@/middlewares/errorHandler';
import { httpLog } from '@/middlewares/httpLogger';
import { setIdempotencyStore } from '@/middlewares/idempotency';
import { notFound } from '@/middlewares/notFound';
import { globalRateLimit } from '@/middlewares/rateLimit';
import { requestId } from '@/middlewares/requestId';
import { security } from '@/middlewares/security';
import { IdempotencyRepository } from '@/repositories/IdempotencyRepository';
import { addressRouter } from '@/routes/api/address.routes';
import { authRouter } from '@/routes/api/auth.routes';
import { balanceRouter } from '@/routes/api/balance.routes';
import { cartRouter } from '@/routes/api/cart.routes';
import { categoryRouter } from '@/routes/api/category.routes';
import { orderRouter } from '@/routes/api/order.routes';
import { paymentRouter } from '@/routes/api/payment.routes';
import { productRouter } from '@/routes/api/product.routes';
import { refundRouter } from '@/routes/api/refund.routes';
import { adminAuthRouter } from '@/routes/admin/adminAuth.routes';
import { adminRefundRouter } from '@/routes/admin/refund.routes';

/**
 * 健康检查路由。
 *
 * @description 两个端点职责不同，别合并：
 * - `GET /health`：存活探针，**不查任何依赖**，进程还活着就返回 200。
 *   若在这里查库，一次数据库抖动会让 k8s 把所有实例全部重启，故障反而扩大；
 * - `GET /health/ready`：就绪探针，检查 Prisma / Redis 连通性，不健康时返回 503，
 *   让网关把流量摘走，但不重启进程。
 *
 * @returns 健康检查路由
 */
function buildHealthRouter(): Router {
  const router = express.Router();

  router.get('/health', (_req, res) => {
    sendOk(res, {
      status: 'ok',
      env: config.env,
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  router.get(
    '/health/ready',
    asyncHandler(async (_req, res) => {
      const db = await isPrismaHealthy();
      const redis = isRedisAvailable();
      const ready = db && redis;

      sendOk(res, { ready, db, redis }, ready ? 'OK' : '依赖不可用', ready ? 200 : 503);
    }),
  );

  return router;
}

/**
 * 创建并装配 Express 应用。
 *
 * @description 每次调用返回一个全新实例（不共享全局状态），便于测试隔离。
 *
 * 有序性说明（为什么限流在 bodyParser 之前）：
 * 限流的目的是**尽早丢弃**超额请求。若先解析 body，攻击者只要持续发送超限的大 body，
 * 就能在解析阶段耗尽 CPU 与内存，限流形同虚设。
 *
 * @returns 装配完成的 Express 应用（未监听端口）
 */
export function createApp(): Application {
  const app = express();

  // 暴露框架指纹没有收益，只方便攻击者挑选已知漏洞
  app.disable('x-powered-by');
  // 取真实客户端 IP：限流、风控、审计日志都依赖它；
  // 跳数来自配置而不是硬编码，避免上游网关层数变化时取错 IP
  app.set('trust proxy', config.security.trustProxy);

  /**
   * 全局 JSON 序列化 replacer —— **删掉这行所有带金额的接口都会 500**。
   *
   * 为什么必须显式设置：
   * 1. 本项目金额字段（`price` / `minPrice` / `maxPrice` 等）一律是 Prisma `BigInt`（单位「分」，
   *    docs/03-database.md §1.2），Prisma 返回的是 JS `bigint`；
   * 2. Express 的 `res.json` 走原生 `JSON.stringify`，而原生实现遇到 bigint 直接抛
   *    `TypeError: Do not know how to serialize a BigInt`，异常一路冒泡到 errorHandler，接口输出 500；
   * 3. {@link jsonReplacer} 负责 bigint → number，且超出 `Number.MAX_SAFE_INTEGER` 时**降级为字符串**，
   *    避免静默丢精度（宁可让前端按字符串处理，也不返回一笔算错的金额）。
   *
   * 这是 `app.set` 级别的**全局设置**，覆盖所有 `res.json`（含成功响应与错误响应），
   * 因此业务层（service / controller）可以放心持有 bigint，不必在每个出口手工 `Number()` 转换。
   *
   * 不这样做的替代方案是「让 service 直接输出 number」，但那会违反「金额一律 BigInt 存分」的铁律，
   * 并且会与缓存快照的 bigint↔number 转换设计打架：SkuService 刻意让 service 对外只暴露 bigint，
   * 缓存层内部才用 number 承载（见 src/services/SkuService.ts 的 `SkuPricePayload` 说明）。
   */
  app.set('json replacer', jsonReplacer);

  // 1. 链路 ID：必须最先，后续所有日志与错误响应都靠它串联
  app.use(requestId());
  // 2. HTTP 访问日志（入口 + finish 钩子出口）
  app.use(httpLog());
  // 3. 跨域白名单
  app.use(cors());
  // 4. 安全响应头 + 参数污染防护
  app.use(security());
  // 5. 全局限流（先于 bodyParser）
  app.use(globalRateLimit());
  // 6. 请求体解析（保留 rawBody 供回调验签）
  app.use(bodyParser());

  /**
   * 注册数据库版幂等存储（**必须在业务路由挂载之前**）。
   *
   * 为什么必须注册：中间件默认是进程内 Map（`InMemoryIdempotencyStore`），
   * 多实例部署时每个实例各持一份，同一 Idempotency-Key 打到不同实例会各下一次单；
   * 单实例重启后 Map 清空，客户端重发即重复下单。而 `OrderService` 把「不重复下单」
   * 这条铁律完全押在幂等中间件上，因此这里必须换成 `idempotency_records` 表的实现。
   *
   * 这里只是 `new` 一个对象（仓储不持有连接、构造时不连库），故无 MySQL 环境下也不会报错。
   */
  setIdempotencyStore(new IdempotencyRepository());

  // 12. 业务路由：T005+ 各业务模块（routes/api / routes/admin / routes/internal）
  // 在此按 `app.use('/api', apiRouter)` 的形式挂载；健康检查先注册，便于最早期联调
  app.use('/api/auth', authRouter);
  app.use('/admin/auth', adminAuthRouter);
  // 分类：/api/categories/tree（分类树，公开读）
  app.use('/api', categoryRouter);
  // 商品 / SKU：/api/products（列表、详情）、/api/skus/:id/quote（报价），均为公开读
  app.use('/api', productRouter);
  // 购物车：/api/cart/*（用户私有数据，路由内部对每个端点单独挂 auth({ scope: 'shop' })）
  app.use('/api', cartRouter);
  // 收货地址：/api/addresses/*（用户私有数据，下单 T050 的必要前置，路由内部对每个端点单独挂 auth）
  app.use('/api', addressRouter);
  // 余额：/api/balance（查余额 / 流水 / 创建充值单；用户私有资金数据，路由内部对每个端点单独挂 auth）
  app.use('/api', balanceRouter);
  // 下单：POST /api/orders（事务 A，路由内部挂 auth + 10 次/分限流 + 幂等抢占 + 校验）
  app.use('/api', orderRouter);
  // 支付：POST /api/payments（发起支付，含幂等）；mock 确认端点仅在非生产环境注册
  app.use('/api', paymentRouter);
  // 退款：/api/refunds（申请 / 列表 / 详情，C 端用户私有资金数据）
  app.use('/api', refundRouter);
  // 后台退款审核：/admin/refunds/:refundNo/audit（审核 + 触发执行）
  app.use('/admin', adminRefundRouter);
  app.use(buildHealthRouter());

  // 13. 兜底 404（必须在所有业务路由之后）
  app.use(notFound());
  // 14. 全局异常（必须最后注册）
  app.use(errorHandler());

  return app;
}

export default createApp;
