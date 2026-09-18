# 阶段 12 · 资金域闭环 — 实现方案（T070 / T080 / T090 / T091）

> 最后更新：2026-09-18 ｜ 范围：路线图 `docs/11-roadmap-ecommerce-modules.md` 阶段 12
> 目标：把「下单 → 支付 → 退款 → 对账」资金链路从代码层补全到**可运营**。
> 约束：本沙箱无 MySQL/Redis/Docker，仅能做 `tsc` + 单测；**真实验证需在你本机 Docker 上跑**（见 `docs/docker-startup.md`）。

---

## 一、现状盘点（已具备 / 缺失，均附证据）

| 任务 | 能力 | 成熟度 | 证据 |
| --- | --- | --- | --- |
| **T070 余额/充值** | 余额开户/明细 | ✅ 已具备 | `BalanceService.getOrCreateAccount/getBalance/listTransactions`；`routes/api/balance.routes.ts`；`web/src/views/BalanceView.vue` |
| | 充值建单委托 `buildConfiguredPayUrl` | ✅ 已具备 | `RechargeService.buildPayUrl`（`RechargeService.ts:197`） |
| | 充值回调双流水入账 | ✅ 已具备 | `PaymentService.settleRecharge`（`PaymentService.ts:648`）+ 单测 |
| | **支付密码中间件接线** | ❌ 缺失 | `requireBalancePassword`/`setPayPasswordHandlers` 仅定义未挂载（`middlewares/balancePassword.ts`）；`balance-pay` 路由未校验支付密码（安全隐患） |
| | **充值单查询 / 超时关单** | ❌ 缺失 | 仅建单+入账；`RechargeService.persist` 已写 `expireAt` 但无消费者 |
| **T080 退款审核/重试** | 申请/审核/执行（BALANCE） | ✅ 已具备 | `RefundService.apply/audit/execute`（`RefundService.ts:240/327/431`） |
| | CHANNEL 退款适配器接缝 | ✅ 已具备 | `execute` CHANNEL 分支（`RefundService.ts:461`）+ `refundAdapter.ts`（缺口 #3） |
| | `markChannelFailed` | ✅ 已具备 | `RefundService.ts:614`（置 FAILED + `failReason` + `retryCount++`） |
| | **重试 Worker（指数退避）** | ✅ 已完成 | `RefundService.retry`（`RefundService.ts`）+ `jobs/handlers/retryRefund.job.ts` + `scheduler.ts` 注册；`markChannelFailed` 现已写 `nextRetryAt`（`bizRules.REFUND_RULE` 退避：60s×2^(n-1) 封顶 1h，上限 8 次） |
| | IdempotencyService 收尾 | ⚠️ TODO | `execute` 步骤 7（`RefundService.ts:539`）未接，标注"不依赖外部幂等组件" |
| **T090 对账** | 双视图对账服务 | ❌ 缺失 | 全仓无 `ReconciliationService`；仅错误码 `FUND_RECONCILE_MISMATCH`（`errorCodes.ts:252`） |
| | 后台对账页 API | ❌ 缺失 | 无对应控制器/路由 |
| | 数据基础 | ✅ 已具备 | `FundService` 记账原语（`recordBalancePayment/Refund`）+ 平台账户 `PLATFORM_CASH` 流水；`account_ledgers` 模型存在 |
| **T091 后台支付/任务** | `closeTimeoutOrder` 调度 | ✅ 已具备 | `jobs/handlers/closeTimeoutOrder.job.ts` + `scheduler.ts:87` |
| | `autoConfirm` 调度 | ✅ 已具备 | `jobs/handlers/autoConfirmReceipt.job.ts` + `scheduler.ts:121` |
| | **`retryRefund` 调度接入** | ✅ 已完成 | `scheduler.ts` 注册每分钟 cron 兜底扫描（启动即补偿一次） |
| | **Redis 分布式锁 / 选主** | ✅ 已完成 | `core/distLock.ts`：`tryAcquireLock`（`SET shop:lock:{key} 1 PX ttl NX`），降级放行；`scheduler.ts` 三处 cron 兜底（关单 / 自动确认 / 退款重试）均加锁 |
| | **后台支付方式管理台** | ❌ 缺失 | 仅 `PaymentMethodStatus` 枚举（`enums.ts:512`）；无 service/controller/route；`adapter.payment.provider` 来自 env，无 DB 配置项 |

---

## 二、推荐构建顺序（由运营必需到增强）

1. **T080 退款重试 + T091 调度落地/分布式锁（本批先做）**
   - 理由：CHANNEL 退款失败当前会永久卡在 `FAILED`（无恢复路径，真实资损隐患）；多实例下 cron 兜底无锁（重复关单/确认风险）。这是"可运营"的**直接缺口**，且改动内聚、可单测。
   - 子项：
     - `markChannelFailed` 补 `nextRetryAt` 指数退避（`retryCount` 次幂，封顶）——`bizRules.REFUND_RULE.backoffMs(attempt)`，60s×2^(n-1) 封顶 1h，`RETRY_MAX=8`；命中上限后 `nextRetryAt=null`（终态转人工）。`where.status` 放宽到 `[PROCESSING, FAILED]`（覆盖重投失败再次补偿的并发场景）。
     - `RefundService.retry(refundNo)`：守卫（非 FAILED / `retryCount≥MAX` / re-arm 落空 → `skipped`/`exhausted`）；**复用 `execute`** 而非新抽 `settleRefund`——`FAILED→PROCESSING` 重武装后直接调 `execute`，确保结算体（步骤 2-7）只有一处实现、记账不漂移（资损红线）；`execute` 再抛 41004 时补偿 `markChannelFailed`。`execute` 行为**零改动**。
     - 新增 `jobs/handlers/retryRefund.job.ts`：`scanFailedRefunds()`（捞 `FAILED & nextRetryAt<=now & retryCount<MAX`，走 `idx_status_next_retry_at`，按 `nextRetryAt` 升序）+ `retryRefund(refundNo)`。
     - `scheduler.ts`：注册 retryRefund Worker + cron 兜底（**带 Redis 分布式锁 `SET NX PX` 选主**，T091 锁）。
     - 单测：mock adapter 成功/失败、退避到点、重试封顶。
   - 不碰 schema（`nextRetryAt` 字段已存在）。
2. **T070 支付密码接线（安全收口）**
   - `balance-pay` 路由挂 `requireBalancePassword`；`bootstrap` 注册 `setPayPasswordHandlers`（compare + 是否设密码）；新增"设置/修改支付密码" API + 前端；`validators` 补 `payPassword` 校验。
3. **T070 充值单查询 + 超时关单**
   - `RechargeService.list` + `GET /balance/recharges` + 前端充值记录 tab；新增充值超时关单 Worker（消费 `expireAt` → PENDING→CLOSED）。
4. **T090 双视图对账**
   - `ReconciliationService`：用户余额账户 + 平台账户双视图；恒等式 L1/L2/L3 校验（L1 余额变动守恒；L2 负债=未退渠道退款；L3 平台收入恒等式）；`FUND_RECONCILE_MISMATCH` 触发告警。
   - 后台对账页 API + 前端。
5. **T091 后台支付方式管理台**
   - 由于 `provider` 来自 env，管理台定位为"渠道可见性/状态元数据 + 切换指引"，不直改 env；提供查询/启用禁用（写 `PaymentMethod` 表）+ `provider` 当前值展示。

---

## 三、测试与验证

- **沙箱内**：每子项完成后跑 `cd server && npm run typecheck`（tsc 0 error）+ `npm test`（相关 suite 绿）。
- **你本机 Docker**：`prisma migrate deploy && seed` 后，端到端走"下单→支付(mock)→退款(后台审核)→渠道失败→重试 Worker 捞起重试/封顶"链路验证。
- **红线（必须遵守）**：
  - 记账一律走 `FundService.recordBalance*`，**禁止内联三流水**（`FundService.ts` 注释铁律）。
  - 渠道退款缺凭据显式抛错、绝不静默降级为 MOCK（§6.7）。
  - `paymentRouter.ts` 保持零 `@/config` 依赖（其 spec 不 mock config）。

---

## 四、本批交付（第一批：T080 重试 + T091 锁）

见上「构建顺序 #1」。完成后提交并推送，其余批次按上序续做。

### 4.1 已落地文件（2026-09-18 提交）

| 文件 | 改动 |
| --- | --- |
| `server/src/constants/bizRules.ts` | 新增 `REFUND_RULE`（`RETRY_BASE_MS=60_000` / `RETRY_CAP_MS=3_600_000` / `RETRY_MAX=8` / `backoffMs(attempt)`） |
| `server/src/services/RefundService.ts` | `markChannelFailed` 写 `nextRetryAt` 退避 + `where.status` 放宽 `[PROCESSING, FAILED]`；新增 `retry(refundNo)`（复用 `execute`） |
| `server/src/core/distLock.ts` | **新增** `tryAcquireLock`（`SET shop:lock:{key} 1 PX ttl NX`，Redis 不可用/命令失败降级放行） |
| `server/src/jobs/handlers/retryRefund.job.ts` | **新增** `scanFailedRefunds()` + `retryRefund(refundNo)` |
| `server/src/jobs/scheduler.ts` | 注册退款重试 cron（每分钟，启动即补偿）；关单 / 自动确认 / 退款重试三处 cron 兜底均加 Redis 分布式锁；`stopScheduler` 清理 `retryTimer` |
| `server/src/tests/unit/refundRetry.spec.ts` | **新增** `markChannelFailed` 退避 + `retry` 状态机（9 用例） |
| `server/src/tests/unit/retryRefundJob.spec.ts` | **新增** `scanFailedRefunds` 扫描条件 + `retryRefund` 透传 + `tryAcquireLock` 四态（6 用例） |

### 4.2 验证结果

- `tsc --noEmit`：**0 error**。
- `eslint`（改动文件）：**0 error / 0 warning**。
- `jest --runInBand`：**461/461 全绿**（含新增 15 用例，既有 refund 套件无回归）。
- 沙箱无 MySQL/Redis，真实验证待用户本机 Docker（`docs/docker-startup.md`）：端到端走"下单→支付(mock)→退款审核→渠道失败→重试 Worker 捞起重投 / 封顶转人工"。

### 4.3 设计取舍与遗留

- **复用 `execute` 而非抽 `settleRefund`**：避免结算体两处实现导致记账漂移（资损红线）。代价是重试路径会重跑 `execute` 的 `PROCESSING→SUCCESS` 幂等闸门——这是期望行为。
- **`execute` 全链路无条件 `recordBalanceRefund`（步骤 6）对 CHANNEL 退款是潜在双付隐患**：本期因 Mock 永远抛 41004、事务回滚，`recordBalanceRefund` 永不触达 CHANNEL 成功分支，故安全。真实网关接入（下一批）时**必须**让 `recordBalanceRefund` 仅对 BALANCE 退款/平台负债结转生效，CHANNEL 走渠道流水——此为缺口 #3 接缝批次的硬收口项，已在 `docs/10-缺口收口记录.md:81` 标注。
- **分布式锁仅自动过期（PX），不主动释放**：TTL > 扫描间隔即可，standby 实例最多干等一个 TTL；与 `scheduler.ts:17` 原注释口径一致，够用且不引入 token+Lua 复杂度。
- **IdempotencyService 收尾仍未接**（T080-B 标注 TODO）：当前靠 `execute` 的条件更新闸门兜底幂等，`retry` 的 re-arm 也是条件更新，重复执行安全。
