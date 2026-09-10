# 电商商城系统 — 系统架构设计

| 项目信息 | 内容 |
| --- | --- |
| 文档版本 | **v2.0**（客户已确认 v1.0，本版为 4 项变更的增量修订） |
| 阶段 | 第一阶段：商城核心功能（+ 优惠券/促销、动态角色、三渠道支付、用户余额） |
| 上游文档 | `docs/01-PRD.md`（v1.0）、`docs/05-PRD-变更.md`（变更业务规则，PM 并行编写中） |
| 下游文档 | `docs/03-database.md`（表设计）、`docs/04-flows.md`（关键流程） |
| 项目名（snake_case） | `shop_web` |
| 文档语言 | 简体中文 |

> **本文档定位**：只定义「怎么搭、怎么分层、约定是什么」。不含完整业务代码实现（关键签名、事务骨架、配置示例除外）。
> **阅读顺序**：先读第 1 章技术选型 → 第 3/4 章目录结构（照着建文件）→ 第 5 章统一约定（照着写公共能力）→ 第 6 章适配器 → 第 7 章安全 → 第 10 章异步队列。
>
> **[v2 变更]** 所有相对 v1.0 的修订处均以 `> **[v2 变更]**` 前缀显式标注。

---

## 变更记录（v1.0 → v2.0）

> **[v2 变更]** 本章为 v2 新增。客户在确认 v1.0 三份文档后提出 4 项变更，以下为变更项、被推翻的 v1 假设、以及本文档的落点。

| # | 客户变更 | 被推翻的 v1 假设 | 主要落点（本文档） | 落点（`03-database.md`） | 落点（`04-flows.md`） |
| --- | --- | --- | --- | --- | --- |
| ① | 做优惠券 / 促销 | **A2**：`discount_amount` 恒 0（PRD Q12=A 一期不做） | §3 目录树新增 `coupon/` `promotion/`；§5.2 新增 `12xxx` 错误码段；§5.11 新增金额恒等式族；新增 §9 优惠计算引擎 | 新增 `coupon_templates`、`coupon_template_scopes`、`coupons`、`promotions`、`promotion_rules`、`promotion_scopes`、`order_coupon_records`（7 张）；`orders`/`order_items` 加优惠字段 | F5 加优惠计算与分摊；新增 **F13 优惠券领取与使用**；F9 加优惠退回 |
| ② | 做动态角色管理台 | **A8**：一期用枚举角色 + 权限点常量 | **§7.2 全量重写**为动态 RBAC（5 张表 + Redis 权限缓存）；§3 目录树新增 `rbac` 分支；§5.9 新增权限缓存 key | 新增 `roles`、`permissions`、`role_permissions`、`admin_user_roles`（4 张）；`admin_users` 移除 `role` 枚举列；给出迁移方案 | — |
| ③ | 支付扩到支付宝 + 微信 + 银行卡；回调改异步 | **A9**：一期仅模拟支付、回调同步处理 | **§6.5.2/6.5.3/6.5.6 补齐三个真实渠道**（含银行卡选型对比与推荐）；新增 **§6.6 支付渠道路由**与**§6.7 支付方式管理**；新增 **§10 异步队列设计**（BullMQ + Worker + 死信） | `payments` 加 `pay_method`/`biz_type`；新增 `payment_methods`、`recharge_orders`；**1 订单 = 1 有效支付单**；D2 部分退款提 P0（行级退款，非多段退款） | **F6 全量重做**为异步回调链路；F9 更新为**行级退款 + 按 `pay_method` 单一路由** |
| ④ | 用户余额账户 + 充值 + 消费 | **D3**：`fund_accounts` 只有 1 条平台账户、单式流水 | **§8 资金模型全量重写**（记账模型论证见 `03-database.md` §3.6.4）；§5.11 金额恒等式族；§3 目录树新增 `balance`/`recharge` 分支；§5.9 新增账户锁 key | `fund_accounts` 扩 `USER_BALANCE` 账户类型 + `frozen_balance` 启用 + 支付密码；`fund_transactions` 加 `counterparty_account_id`/`tx_group_no`；新增 `recharge_orders` | **F6 重做**（含余额扣减与负债结转）；新增 **F14 余额充值**、**F15 余额支付下单与退款**；F11 加双账户对账视图 |

> **[v2 变更 · v1.1 更正]** 客户在提出上述 4 项变更后**追加更正：取消混合支付**——一笔订单只能用一种支付方式（全额余额 **或** 全额走支付宝/微信/银行卡）。因此本表 ③④ 已按单一支付口径修正：**不存在** `refund_segments` 多段退款表、**不存在** `balance_paid`/`channel_paid` 拆分字段、**不存在** 退款分配模式（PRO_RATA / BALANCE_FIRST / CHANNEL_FIRST）、幂等 scope 统一为 `PAY:{orderNo}`。金额恒等式回归 `应付总额 = 商品金额 - 优惠金额 + 运费`。详见 `05-PRD-变更.md` §9.2 与 `03-database.md` §3.5 口径说明。

**v1.0 中继续有效、未受影响的决策**（客户明确「其它按默认优化的选择」）：

| 项 | 结论 |
| --- | --- |
| A1 单商户自营 | ✅ 保持（无多商户、无分账） |
| A5 无多规格图片 | ✅ 保持（多规格图片仍为 P2） |
| A6 部署形态 | ✅ 单机部署，架构按多实例预留 |
| A7 注册方式 | ✅ 手机号 + 密码（短信验证码走 mock 适配器预留） |
| D1 多支付单 | ✅ 一笔订单可有多条 `payments` 记录，同时只有一条能成功 |
| D4 CHECK 约束 | ✅ 全部启用 |
| D5 商品搜索 | ✅ 一期不上 FULLTEXT，用 `LIKE 'kw%'` 前缀匹配 |
| Q2 库存扣减时机 | ✅ 下单冻结（`stock.deductMode = 'order'`） |
| Q3 待支付超时 | ✅ 30 分钟 |
| Q4 运费规则 | ✅ 满 9900 分包邮，否则 1200 分 |
| Q6 售后期 | ✅ 7 天 |
| Q8 商品审核流 | ✅ 一期不做 |
| Q9 多商户 | ✅ 单商户自营 |
| Q13 前端工程 | ✅ 单一 Vite 工程，路由分区 |
| Q14 商品评价 | ✅ 一期不做 |

---

## 0. 已拍板约束（客户决策，优先级高于 PRD 推荐值）

| # | 决策项 | 结论 | 对设计的硬约束 |
| --- | --- | --- | --- |
| 1 | 数据库 | **MySQL 8.0** | SQL 方言用 MySQL；金额用 `BIGINT` 存「分」；依赖 InnoDB 行锁与 `SELECT ... FOR UPDATE`；注意间隙锁，扫描关单走主键/索引分页 |
| 2 | 数据访问 | **Prisma** | 模型定义在 `prisma/schema.prisma`；迁移用 `prisma migrate`；资金+订单+库存的原子操作用 `prisma.$transaction(async tx => {...})` 交互式事务；CAS 条件更新用 `$executeRaw`（Prisma 不支持条件更新表达式） |
| 3 | 前端形态 | **单一 Vite 工程，路由分区** | `/`、`/goods`、`/cart`、`/orders`、`/user/*` = C 端；`/admin/*` = 后台；共享组件/工具/API client；路由守卫 + 双 Layout 区分外观 |
| 4 | Redis | **引入** | 限流、幂等前置拦截、热点 SKU 锁、缓存走 Redis；**资金/库存/订单状态的权威源永远是 MySQL，Redis 只做性能与并发辅助**（见 5.9） |
| 5 | 后端框架 | **Node.js + Express** | 分层：Route → Controller → Service → Repository |
| 6 | 前端框架 | **Vue 3 + Vite** | 补充选型：Pinia + Vue Router 4 + Element Plus（后台）+ 自研 C 端样式 |
| 7 | 库存扣减时机 | 沿用 PRD Q2 推荐 = **下单冻结** | 见 5.10，`stock.deductMode = 'order'` |
| 8 | 运费规则 | 沿用 PRD Q4 推荐 = **满 9900 分包邮，否则 1200 分** | 常量集中在 `config/constants.ts` |
| 9 | 支付 | 一期**仅模拟支付** + 完整接入说明 | 适配器 `provider = mock` |
| 10 | 部署 | 单机优先，架构按多实例预留 | 服务无状态；定时任务用 Redis 选主/队列，保证多实例不重跑 |
| 11 | **[v2 变更] 优惠券与促销** | **一期实现**（推翻 A2） | 券模板/券实例/活动三套模型；优惠计算引擎在下单事务前调用；券冻结/解冻/核销与订单事务绑定；优惠必须分摊到订单行 |
| 12 | **[v2 变更] 后台权限** | **动态 RBAC 管理台**（推翻 A8） | 5 张表 + Redis 权限缓存；路由守卫从「角色」改为「权限点编码」；内置超级管理员绕过校验；权限变更实时生效 |
| 13 | **[v2 变更] 支付渠道** | **支付宝 + 微信 + 银行卡**（推翻 A9） | 适配器扩到 4 个真实实现；**所有渠道回调统一走异步队列**（微信强制 5s 内应答）；支付渠道路由层；后台支付方式管理 |
| 14 | **[v2 变更] 用户余额** | **用户维度余额账户 + 充值 + 消费**（推翻 D3） | 每用户一条 `USER_BALANCE` 账户；充值复用 `payments`；余额不可透支（`CHECK balance >= 0`）；**支付方式单选，不做混合支付**（v1.1 更正）；余额支付的订单退款退回余额，渠道支付原路退回；**部分退款提 P0**（行级退款，非多段退款） |
| 15 | **[v2 变更] 记账模型** | **方案 A+：单式流水 + 对手方 + 交易组号** | 论证见 `03-database.md` §3.6.4。`fund_transactions` 加 `counterparty_account_id` + `tx_group_no`；负债作为派生视图校验，不引入全局负债账户 |

---

## 1. 技术选型表

### 1.1 后端

| 类别 | 选型 | 版本 | 选型理由 | 备选 |
| --- | --- | --- | --- | --- |
| 运行时 | Node.js | 20.x LTS | LTS、原生 `fetch`、`AsyncLocalStorage` 稳定（requestId 全链路依赖） | 22.x |
| 语言 | TypeScript | ^5.4 | 强类型约束金额/枚举/状态机，重构安全；Prisma 类型直接复用 | — |
| Web 框架 | Express | ^4.19 | 客户指定；中间件生态最全、团队熟悉度最高 | Fastify（性能更好，中间件需改写） |
| ORM | Prisma | ^5.22 | 客户指定；schema 即文档、迁移可回溯、类型生成完善、交互式事务好用 | Prisma ^6.x / TypeORM |
| 数据库 | MySQL | 8.0 | 客户指定；行锁/间隙锁行为明确，`CHECK` 约束 8.0.16+ 可用 | PostgreSQL 15 |
| 缓存 / 队列底座 | Redis | 7.x | 限流、分布式锁、BullMQ 队列、缓存四合一 | KeyDB |
| Redis 客户端 | ioredis | ^5.4 | Cluster/Sentinel 支持好，Lua 脚本与 BullMQ 官方依赖 | node-redis |
| 参数校验 | zod | ^3.23 | schema 即类型（一份定义出 TS 类型 + 运行时校验），`validate` 中间件零成本 | joi（类型推导弱） |
| 日志 | winston + winston-daily-rotate-file | ^3.13 / ^5.0 | 结构化 JSON、多 transport、按天切割 | pino（性能更好） |
| 请求上下文 | AsyncLocalStorage | Node 内置 | requestId 全链路隐式透传，不污染函数签名 | cls-hooked（已停止维护） |
| 鉴权 | jsonwebtoken | ^9.0 | 生态成熟，与 refresh token 轮换方案配合简单 | jose（更现代，支持 JWE） |
| 密码哈希 | bcrypt | ^5.1 | 客户 PRD 明确 BCrypt；自适应 cost | argon2id（更安全，需本地编译） |
| 限流 | express-rate-limit + rate-limit-redis | ^7.4 / ^4.2 | 与 Express 无缝；Redis store 支持多实例共享计数 | 自研 Lua 令牌桶（见 5.8） |
| 任务调度 | BullMQ | ^5.13 | 基于 Redis，支持 repeatable / delayed job，多实例天然单消费者；延迟关单可用 delayed job 精确触发 | node-cron（仅作兜底扫描） |
| 定时任务兜底 | node-cron | ^3.0 | 每 1 分钟兜底扫描超时订单，防 BullMQ job 丢失 | — |
| 上传 | multer | ^1.4.5-lts.1 | 事实标准；`diskStorage` 自定义命名；`fileFilter` 白名单 | formidable / 直传 OSS |
| HTML 清洗 | sanitize-html | ^2.13 | 商品详情富文本 XSS 白名单清洗 | DOMPurify（服务端需 jsdom） |
| 安全响应头 | helmet | ^7.1 | CSP / HSTS / X-Frame-Options 一行接入 | 手工设置 |
| HTTP 客户端 | axios | ^1.7 | 拦截器统一做超时/重试/日志/脱敏，适配器层复用 | undici |
| 单号生成 | 自研 `idGenerator` | — | 订单号/支付单号/退款单号/流水号需要「时间前缀 + 业务码 + 序列 + 随机」可读格式，雪花 ID 不满足可读性 | nanoid（仅随机段） |
| Excel 导出 | exceljs | ^4.4 | 后台订单/流水导出（P1） | xlsx（社区版功能受限） |
| 测试框架 | Jest + ts-jest + supertest | ^29 / ^29 / ^7 | 集成测试直接打真实 DB（docker 起 MySQL），覆盖并发防超卖与回调幂等 | Vitest（与前端统一） |
| 进程管理 | PM2 | ^5.4 | 集群模式 + 日志切割 + 优雅重启 | Docker + k8s |

### 1.2 前端

| 类别 | 选型 | 版本 | 选型理由 | 备选 |
| --- | --- | --- | --- | --- |
| 框架 | Vue 3（`<script setup>`） | ^3.4 | 客户指定；组合式 API 复用逻辑清晰（购物车合并、分页、倒计时） | React 18 |
| 构建 | Vite | ^5.2 | 客户指定；dev 秒启、分包配置简单 | Webpack 5 |
| 状态管理 | Pinia | ^2.1 | 官方推荐，TS 推导好，无需 mutations 样板 | Vuex 4 |
| 路由 | Vue Router | ^4.3 | 路由分区 + 守卫实现 C 端 / 后台双入口 | — |
| UI 库 | Element Plus | ^2.7 | 后台表格/表单/弹窗/抽屉开箱即用，中文文档完善 | Naive UI / Ant Design Vue |
| C 端样式 | 自研 SCSS（BEM）+ CSS 变量 | — | 商城 C 端视觉需定制，UI 库反而是负担；后台用 Element Plus | Tailwind CSS |
| 按需引入 | unplugin-vue-components + unplugin-auto-import | ^0.27 / ^0.17 | Element Plus 按需打包，首屏体积可控 | 全量引入 |
| HTTP | axios | ^1.7 | 拦截器统一注入 `Authorization` / `Idempotency-Key`、401 自动刷新、统一错误提示 | — |
| 工具库 | dayjs / lodash-es | ^1.11 / ^4.17 | 时间格式与倒计时、数据处理 | — |
| 测试 | Vitest + @vue/test-utils | ^1.6 / ^2.4 | 与 Vite 同源，配置复用（P1） | Jest |

### 1.3 关键取舍说明

| 取舍点 | 选择 | 放弃的方案 | 原因 |
| --- | --- | --- | --- |
| 金额类型 | `BIGINT`（分）+ 全局 BigInt→Number 序列化 | `DECIMAL(18,2)` / `INT` | PRD 6.1 明令禁止小数金额；`INT` 上限仅 2147 万元，累计余额有溢出风险；BIGINT + 序列化约定可两全（见 `docs/03-database.md` §1.3） |
| 主键类型 | `BIGINT` 自增 | UUID v4 字符串 | InnoDB 聚簇索引，自增主键写入顺序性好、二级索引体积小；业务单号另开唯一索引对外暴露 |
| 后台 RBAC | **[v2 变更]** **动态 RBAC 四表 + Redis 权限缓存** | ~~枚举角色 + 代码内权限点常量~~（v1 方案，已被客户变更②推翻） | 客户明确要求一期即有**动态角色管理台**（可在后台增删角色、勾选权限点、实时生效）。权限点按 `资源:操作` 编码（约 50 个），敏感权限绕过缓存实时判定。代码内**禁止按角色名判断**，只判权限点编码。详见 §7.2 |
| 定时任务 | BullMQ 延迟任务 + node-cron 兜底扫描 | 纯 node-cron 全表扫描 | 延迟任务精确（下单即注册 30 分钟后的关单 job），兜底扫描防 job 丢失，双保险 |
| 库存并发 | CAS 条件更新为权威 + Redis 锁削峰 + version 乐观锁保护读改写 | 纯 Redis 预扣 | Redis 不可作为权威状态源（客户明确要求），纯 DB 方案在热点 SKU 上 CAS 重试风暴需 Redis 锁削峰 |

---

## 2. 总体架构图

```mermaid
flowchart TB
    subgraph C["客户端 Client"]
        W1["C 端 SPA<br/>/ , /goods , /cart , /orders , /user/*"]
        W2["后台 SPA<br/>/admin/*"]
    end

    subgraph MW["中间件链 Middleware Chain（严格顺序，见 5.5）"]
        M1["requestId → httpLogger → cors/helmet"]
        M2["rateLimit（Redis 令牌桶）"]
        M3["bodyParser → auth(JWT) → rbac"]
        M4["validate(zod) → idempotency → upload/pagination"]
    end

    subgraph RT["路由层 Routes"]
        R1["/api/*  C 端路由"]
        R2["/admin/* 后台路由（adminOnly + rbac）"]
        R3["/internal/callbacks 支付回调（验签 + 独立限流，不走用户鉴权）"]
    end

    subgraph CT["控制器层 Controllers"]
        C1["Auth / User / Address / Category / Product / Cart"]
        C2["Order / Payment / Refund / Logistics / Support / Upload"]
        C3["admin/* 后台控制器"]
    end

    subgraph SV["服务层 Services（业务编排 + 事务边界）"]
        S1["AuthService / TokenService / UserService / AddressService"]
        S2["CategoryService / ProductService / SkuService / CartService"]
        S3["PriceService（价格重算/运费/分摊）"]
        S4["StockService（CAS 冻结/确认/释放 + 流水）"]
        S5["OrderService + OrderStateMachine"]
        S6["PaymentService / RefundService"]
        S7["FundService（记账 + 余额快照）"]
        S8["IdempotencyService / ReconciliationService / AuditService"]
    end

    subgraph RP["数据访问层 Repositories"]
        P1["PrismaClient 单例"]
        P2["原生 SQL：库存 CAS / FOR UPDATE 锁账户 / 分页批量扫描"]
    end

    subgraph ITG["第三方适配器层 Integrations（旁挂）"]
        A0["AdapterFactory（按配置返回实现）"]
        A1["PaymentAdapter<br/>mock / alipay / wechat"]
        A2["LogisticsAdapter<br/>mock / kuaidi100 / kuaidiniao"]
        A3["SupportAdapter<br/>mock / qiyu"]
        A4["SmsAdapter<br/>mock / aliyun / tencent"]
    end

    subgraph JOB["定时任务 Worker（旁挂，多实例防重）"]
        J1["closeTimeoutOrder 超时关单"]
        J2["autoConfirmReceipt 自动确认收货"]
        J3["retryRefund 退款重试"]
        J4["cleanupIdempotency 幂等记录清理"]
        J5["scanStockAnomaly 库存巡检"]
        J6["dailyReconcile 每日对账（P2）"]
    end

    subgraph DB["存储"]
        D1[("MySQL 8.0<br/>权威状态源<br/>订单/库存/资金/流水")]
        D2[("Redis 7<br/>限流/锁/缓存/队列<br/>非权威")]
        D3[("本地磁盘 uploads/<br/>可扩展 OSS")]
    end

    C --> MW --> RT --> CT --> SV --> RP
    RP --> D1
    SV -.->|限流/锁/缓存| D2
    SV --> ITG
    ITG -.->|调用日志| D1
    ITG --> EXT["外部服务商<br/>支付宝/微信/快递100/七鱼/阿里云"]
    JOB --> SV
    JOB -.->|Redlock 选主| D2
    CT -.上传.-> D3
```

**分层职责边界（工程师必读）**

| 层 | 能做 | 禁止 |
| --- | --- | --- |
| `routes/` | 绑定路径、挂载中间件、声明 zod schema | 写任何业务逻辑 |
| `controllers/` | 取参、调 Service、组装响应 | 直接访问 Repository、写事务、写 SQL |
| `services/` | 业务规则、状态机、**事务边界**、编排 Repository 与适配器 | 接触 `req`/`res` 对象 |
| `repositories/` | 单表 CRUD、原生 SQL、Prisma 查询构造 | 写业务规则、跨领域编排 |
| `integrations/` | 外部协议转换、签名、超时重试 | 直接访问 Repository（结果由 Service 落库） |

---

## 3. 目录结构（后端 `server/`）

> 颗粒度到具体文件名，工程师照此建文件。

```
server/
├── package.json                          # 依赖与脚本：dev/build/start/migrate/seed/test
├── tsconfig.json                         # strict: true，路径别名 @/*
├── nodemon.json                          # 开发热重载
├── .env.example                          # 环境变量样例（不含真实密钥，入代码库）
├── .eslintrc.cjs                         # 代码规范
├── .prettierrc
├── jest.config.ts                        # 集成测试（连真实 MySQL）
├── Dockerfile
├── prisma/
│   ├── schema.prisma                     # 数据模型（见 docs/03-database.md）
│   ├── seed.ts                           # 种子数据入口（管理员/分类/商品/SKU/库存/测试用户）
│   ├── seed/
│   │   ├── admin.seed.ts                 # 管理员账号
│   │   ├── category.seed.ts              # 三级分类树
│   │   ├── product.seed.ts               # 商品 + 图集 + 规格 + SKU + 库存
│   │   ├── user.seed.ts                  # 测试买家与地址
│   │   ├── fundAccount.seed.ts           # 平台现金账户（1 条，余额 0）+ 测试用户余额账户
│   │   ├── rbac.seed.ts                  # [v2 新增] 权限点 / 角色 / 角色权限 / 管理员角色绑定
│   │   ├── coupon.seed.ts                # [v2 新增] 券模板 + 券实例（满减/折扣/无门槛各若干）
│   │   ├── promotion.seed.ts             # [v2 新增] 活动 + 规则 + 适用范围
│   │   └── paymentMethod.seed.ts         # [v2 新增] 支付方式（mock/alipay/wechat/unionpay/balance）
│   ├── migrations/                       # prisma migrate 生成，入代码库
│   └── sql/
│       ├── 001_add_check_constraints.sql # CHECK(available>=0) 等（Prisma 不支持，手工迁移）
│       └── 002_add_fulltext_index.sql    # 商品名全文索引（可选）
├── src/
│   ├── app.ts                            # 创建并装配 express app（不含 listen，便于测试）
│   ├── server.ts                         # 启动入口：配置校验 → listen → 优雅退出 → 启动补偿扫描
│   ├── config/
│   │   ├── index.ts                      # 配置聚合出口（export const config）
│   │   ├── env.schema.ts                 # zod 环境变量 schema，启动 fail-fast 校验
│   │   ├── default.ts                    # 与环境无关的默认值
│   │   ├── development.ts
│   │   ├── test.ts
│   │   ├── production.ts
│   │   └── constants.ts                  # 业务常量：超时时长/运费规则/限流阈值/积分占位开关
│   ├── core/
│   │   ├── response.ts                   # ok/fail/paginate 响应构造 + BigInt 序列化 replacer
│   │   ├── errors/
│   │   │   ├── AppError.ts               # 基类：code/httpStatus/data/isOperational
│   │   │   ├── BusinessError.ts          # 业务规则拒绝 → 409
│   │   │   ├── ValidationError.ts        # 参数校验失败 → 400（含字段级 errors[]）
│   │   │   ├── AuthError.ts              # 未认证 401 / 无权限 403
│   │   │   ├── NotFoundError.ts          # 404
│   │   │   ├── ConflictError.ts          # 唯一冲突/并发冲突 → 409
│   │   │   ├── RateLimitError.ts         # 429（带 retryAfter）
│   │   │   ├── ExternalServiceError.ts   # 第三方失败 → 502
│   │   │   ├── errorCodes.ts             # 错误码常量表（分段规则见 5.2）
│   │   │   └── index.ts
│   │   ├── logger/
│   │   │   ├── logger.ts                 # winston 实例（JSON 结构化 + 按天切割）
│   │   │   ├── requestContext.ts         # AsyncLocalStorage：requestId / userId / role
│   │   │   ├── redact.ts                 # 敏感字段脱敏（见 5.3）
│   │   │   └── httpFormat.ts             # HTTP 访问日志格式
│   │   ├── prisma.ts                     # PrismaClient 单例 + 慢查询日志 + 优雅断连
│   │   ├── redis.ts                      # ioredis 单例 + 连接降级（不可用时降级不阻塞主流程）
│   │   ├── money.ts                      # MoneyUtil：分↔元、分摊、安全整数断言、格式化
│   │   ├── idGenerator.ts                # 单号生成器（订单/支付/退款/流水/优惠券）
│   │   ├── transaction.ts                # withTransaction() 封装（含超时与重试）
│   │   ├── queue.ts                      # [v2 新增] BullMQ 队列定义与连接（payment-callback / refund-exec 等）
│   │   ├── accountLock.ts                # [v2 新增] 账户锁：统一加锁顺序（防死锁）+ FOR UPDATE 封装
│   │   └── eventBus.ts                   # 进程内事件总线：order.completed 等（积分体系钩子预留）
│   ├── middlewares/
│   │   ├── requestId.ts                  # 生成/透传 X-Request-Id，写入 AsyncLocalStorage
│   │   ├── httpLogger.ts                 # 请求进入与响应完成的结构化日志
│   │   ├── cors.ts                       # 白名单 CORS
│   │   ├── security.ts                   # helmet + hpp + 请求体大小限制
│   │   ├── rateLimit.ts                  # 限流工厂：byGlobal/byIp/byUser/byRoute
│   │   ├── bodyParser.ts                 # json/urlencoded 解析 + 原始 body 保留（回调验签用）
│   │   ├── auth.ts                       # JWT 解析 → req.auth（可选/强制两种模式）
│   │   ├── authorize.ts                  # [v2 改造] authorize(...permissionCodes) 权限点校验（替换 v1 的 rbac.ts）
│   │   ├── adminOnly.ts                  # scope=admin 校验（C 端 token 打后台 → 403）
│   │   ├── superAdminBypass.ts           # [v2 新增] 内置超级管理员短路放行（在 authorize 之前）
│   │   ├── balancePassword.ts            # [v2 新增] 余额支付密码校验（连续错误锁定，复用登录锁定逻辑）
│   │   ├── validate.ts                   # validate({params,query,body}) zod 校验
│   │   ├── idempotency.ts                # Idempotency-Key 抢占 / 回放 / 冲突（见 5.10）
│   │   ├── upload.ts                     # multer 封装：白名单/大小限制/命名/存储驱动
│   │   ├── pagination.ts                 # 解析 page/pageSize → req.pagination
│   │   ├── notFound.ts                   # 兜底 404 → 统一响应
│   │   └── errorHandler.ts               # 全局异常 → 统一错误响应（最外层）
│   ├── routes/
│   │   ├── index.ts                      # 根路由注册（/api、/admin、/internal）
│   │   ├── api/
│   │   │   ├── index.ts
│   │   │   ├── auth.routes.ts            # /api/auth/*
│   │   │   ├── user.routes.ts            # /api/user/*  个人信息/资金流水（自己的）
│   │   │   ├── address.routes.ts         # /api/addresses/*
│   │   │   ├── category.routes.ts        # /api/categories/*  公开
│   │   │   ├── product.routes.ts         # /api/products/*    公开
│   │   │   ├── cart.routes.ts            # /api/cart/*
│   │   │   ├── order.routes.ts           # /api/orders/*
│   │   │   ├── payment.routes.ts         # /api/payments/*
│   │   │   ├── refund.routes.ts          # /api/refunds/*
│   │   │   ├── logistics.routes.ts       # /api/logistics/trace
│   │   │   ├── support.routes.ts         # /api/support/session|messages
│   │   │   ├── upload.routes.ts          # /api/upload
│   │   │   ├── coupon.routes.ts          # [v2 新增] /api/coupons/*（可领券列表、领取、我的券、下单可用券）
│   │   │   ├── balance.routes.ts         # [v2 新增] /api/balance/*（账户余额、余额明细、支付密码设置/校验）
│   │   │   └── recharge.routes.ts        # [v2 新增] /api/recharges/*（创建充值单、查询充值记录）
│   │   ├── admin/
│   │   │   ├── index.ts                  # /admin 前缀统一挂 adminOnly + authorize
│   │   │   ├── adminAuth.routes.ts       # /admin/auth/login|logout|profile|refresh
│   │   │   ├── adminCategory.routes.ts   # /admin/categories/*
│   │   │   ├── adminProduct.routes.ts    # /admin/products/*、/admin/skus/*
│   │   │   ├── adminStock.routes.ts      # /admin/stock/*、/admin/stock-logs/*
│   │   │   ├── adminOrder.routes.ts      # /admin/orders/*（详情/发货/取消/导出）
│   │   │   ├── adminRefund.routes.ts     # /admin/refunds/*（审核/重试）
│   │   │   ├── adminUser.routes.ts       # /admin/users/*（查看/禁用）
│   │   │   ├── adminFund.routes.ts       # /admin/fund/transactions|reconcile|accounts
│   │   │   ├── adminDashboard.routes.ts  # /admin/dashboard/stats
│   │   │   ├── adminAdmin.routes.ts      # /admin/admins/*（管理员账号管理）
│   │   │   ├── adminLog.routes.ts        # /admin/operation-logs/*
│   │   │   ├── adminRole.routes.ts       # [v2 新增] /admin/roles/*（角色 CRUD + 权限分配）
│   │   │   ├── adminPermission.routes.ts # [v2 新增] /admin/permissions/*（权限点列表，只读 + 同步）
│   │   │   ├── adminCoupon.routes.ts     # [v2 新增] /admin/coupons/*（券模板 CRUD、发放、作废、统计）
│   │   │   ├── adminPromotion.routes.ts  # [v2 新增] /admin/promotions/*（活动 CRUD、启停、规则配置）
│   │   │   ├── adminPaymentMethod.routes.ts # [v2 新增] /admin/payment-methods/*（渠道开关、排序、展示名）
│   │   │   ├── adminBalance.routes.ts    # [v2 新增] /admin/balance/*（用户余额查询、余额流水、手工调账）
│   │   │   └── adminRecharge.routes.ts   # [v2 新增] /admin/recharges/*（充值订单查询）
│   │   └── internal/
│   │       └── callbacks.routes.ts       # [v2 改造] /internal/callbacks/payment/:provider<br/>│   │                                     # provider ∈ mock|alipay|wechat|unionpay|aggregate<br/>│   │                                     # 只做：验签 → 落 integration_call_logs → 投递队列 → 立即 200
│   ├── controllers/
│   │   ├── AuthController.ts
│   │   ├── UserController.ts
│   │   ├── AddressController.ts
│   │   ├── CategoryController.ts
│   │   ├── ProductController.ts
│   │   ├── CartController.ts
│   │   ├── OrderController.ts
│   │   ├── PaymentController.ts
│   │   ├── RefundController.ts
│   │   ├── LogisticsController.ts
│   │   ├── SupportController.ts
│   │   ├── UploadController.ts
│   │   ├── CouponController.ts             # [v2 新增] 领券、我的券、结算可用券
│   │   ├── PromotionController.ts          # [v2 新增] 生效活动查询（C 端展示）
│   │   ├── BalanceController.ts            # [v2 新增] 余额查询、余额明细、支付密码
│   │   ├── RechargeController.ts           # [v2 新增] 充值单创建与查询
│   │   └── admin/
│   │       ├── AdminAuthController.ts
│   │       ├── AdminRoleController.ts      # [v2 新增] 角色 CRUD + 权限分配
│   │       ├── AdminPermissionController.ts # [v2 新增] 权限点列表与同步
│   │       ├── AdminCouponController.ts    # [v2 新增]
│   │       ├── AdminPromotionController.ts # [v2 新增]
│   │       ├── AdminPaymentMethodController.ts # [v2 新增] 支付方式开关与排序
│   │       ├── AdminBalanceController.ts   # [v2 新增] 用户余额查询与手工调账
│   │       └── AdminRechargeController.ts  # [v2 新增] 充值订单查询
│   │       ├── AdminCategoryController.ts
│   │       ├── AdminProductController.ts
│   │       ├── AdminStockController.ts
│   │       ├── AdminOrderController.ts
│   │       ├── AdminRefundController.ts
│   │       ├── AdminUserController.ts
│   │       ├── AdminFundController.ts
│   │       ├── AdminDashboardController.ts
│   │       ├── AdminAdminController.ts
│   │       └── AdminLogController.ts
│   ├── services/
│   │   ├── AuthService.ts                # 注册/登录/刷新/登出/密码校验
│   │   ├── TokenService.ts               # access/refresh 签发、轮换、吊销、tokenVersion
│   │   ├── UserService.ts
│   │   ├── AddressService.ts             # 含默认地址互斥
│   │   ├── CategoryService.ts            # 分类树、层级校验、删除前置校验
│   │   ├── ProductService.ts             # SPU 列表/详情/缓存
│   │   ├── SkuService.ts                 # SKU 组合、价格与库存实时查询
│   │   ├── CartService.ts                # 加购/改量/勾选/删除/合并/失效校验
│   │   ├── PriceService.ts               # 【核心】服务端价格重算 + 运费 + 分摊 + 恒等式校验
│   │   ├── StockService.ts               # 【核心】CAS 冻结/确认/释放 + 库存流水
│   │   ├── OrderService.ts               # 【核心】下单/取消/发货/确认收货/超时关单
│   │   ├── OrderStateMachine.ts          # 状态跃迁白名单 + 非法流转拒绝
│   │   ├── PaymentService.ts             # 创建支付单/查询/关单/回调处理
│   │   ├── RefundService.ts              # 申请/审核/执行退款/重试
│   │   ├── FundService.ts                # 【核心】记账：账户锁定 + 余额快照 + 流水 + 冲正
│   │   ├── ReconciliationService.ts      # 单笔订单资金全景还原 + 每日对账
│   │   ├── LogisticsQueryService.ts      # 物流轨迹查询（带缓存 + 降级）
│   │   ├── SupportService.ts             # 客服会话
│   │   ├── UploadService.ts              # 落盘 + 写 upload_file
│   │   ├── IdempotencyService.ts         # 抢占/回放/清理
│   │   ├── AuditService.ts               # 后台操作日志
│   │   ├── DashboardService.ts           # 后台仪表盘聚合
│   │   └── CacheService.ts               # Redis 缓存封装 + 失效策略
│   ├── repositories/
│   │   ├── BaseRepository.ts             # 通用分页/软删/存在性校验
│   │   ├── UserRepository.ts
│   │   ├── AddressRepository.ts
│   │   ├── CategoryRepository.ts
│   │   ├── ProductRepository.ts
│   │   ├── ProductSpecRepository.ts
│   │   ├── SkuRepository.ts
│   │   ├── SkuStockRepository.ts         # 含 CAS 原生 SQL（freeze/confirm/release）
│   │   ├── StockLogRepository.ts
│   │   ├── CartRepository.ts
│   │   ├── OrderRepository.ts            # 含超时扫描、条件更新状态
│   │   ├── OrderStatusLogRepository.ts
│   │   ├── PaymentRepository.ts
│   │   ├── RefundRepository.ts
│   │   ├── FundAccountRepository.ts      # 含 FOR UPDATE 锁账户
│   │   ├── FundTransactionRepository.ts  # 只读 + 插入（无 update/delete 方法）
│   │   ├── IdempotencyRepository.ts
│   │   ├── AdminUserRepository.ts
│   │   ├── OperationLogRepository.ts
│   │   ├── UploadFileRepository.ts
│   │   └── IntegrationCallLogRepository.ts
│   ├── integrations/
│   │   ├── AdapterResult.ts              # { success, code, message, data, raw }
│   │   ├── AdapterError.ts
│   │   ├── AdapterFactory.ts             # get(type) → 按配置返回实现（进程内单例缓存）
│   │   ├── registry.ts                   # provider → 实现类映射表
│   │   ├── httpClient.ts                 # axios 实例：超时/重试/调用日志/脱敏
│   │   ├── payment/
│   │   │   ├── PaymentAdapter.ts         # 接口 + DTO 类型定义
│   │   │   ├── MockPaymentAdapter.ts     # 模拟支付页 + 模拟异步回调
│   │   │   ├── AlipayPaymentAdapter.ts   # 占位：构造签名/验签骨架 + throw NotImplemented
│   │   │   ├── WechatPaymentAdapter.ts   # 占位
│   │   │   └── index.ts
│   │   ├── logistics/
│   │   │   ├── LogisticsAdapter.ts
│   │   │   ├── MockLogisticsAdapter.ts
│   │   │   ├── Kuaidi100LogisticsAdapter.ts
│   │   │   ├── KuaidiniaoLogisticsAdapter.ts
│   │   │   └── index.ts
│   │   ├── support/
│   │   │   ├── SupportAdapter.ts
│   │   │   ├── MockSupportAdapter.ts     # 内存会话 + 消息落库
│   │   │   ├── QiyuSupportAdapter.ts
│   │   │   └── index.ts
│   │   └── sms/
│   │       ├── SmsAdapter.ts
│   │       ├── MockSmsAdapter.ts         # 写日志/控制台 + 固定验证码（可配）
│   │       ├── AliyunSmsAdapter.ts
│   │       ├── TencentSmsAdapter.ts
│   │       └── index.ts
│   ├── jobs/
│   │   ├── queue.ts                      # BullMQ Queue/Worker 定义与注册
│   │   ├── scheduler.ts                  # repeatable job + node-cron 兜底注册
│   │   ├── distributedLock.ts            # Redis SETNX 锁 + 自动续约 + 安全释放（Redlock 简化版）
│   │   ├── handlers/
│   │   │   ├── closeTimeoutOrder.job.ts  # 超时关单
│   │   │   ├── autoConfirmReceipt.job.ts # 自动确认收货
│   │   │   ├── retryRefund.job.ts        # 退款失败重试
│   │   │   ├── cleanupIdempotency.job.ts # 幂等记录清理
│   │   │   ├── scanStockAnomaly.job.ts   # 库存负数/恒等式巡检告警
│   │   │   └── dailyReconcile.job.ts     # 每日对账（P2）
│   │   └── bootstrap.ts                  # 应用启动时补偿扫描（服务重启兜底）
│   ├── validators/
│   │   ├── common.schema.ts              # paginationSchema / idSchema / phoneSchema / moneySchema
│   │   ├── auth.schema.ts
│   │   ├── address.schema.ts
│   │   ├── category.schema.ts
│   │   ├── product.schema.ts
│   │   ├── cart.schema.ts
│   │   ├── order.schema.ts
│   │   ├── payment.schema.ts
│   │   ├── refund.schema.ts
│   │   ├── stock.schema.ts
│   │   └── admin.schema.ts
│   ├── utils/
│   │   ├── hash.ts                       # bcrypt 封装（含 sha256 前置，规避 72 字节截断）
│   │   ├── crypto.ts                     # sha256 / hmac / 随机串
│   │   ├── date.ts                       # dayjs 封装
│   │   ├── paging.ts                     # 分页参数归一化 + Prisma skip/take 计算
│   │   ├── sanitize.ts                   # sanitize-html 白名单（商品详情）
│   │   ├── mask.ts                       # 手机号/姓名/地址脱敏
│   │   ├── fingerprint.ts                # 请求体 sha256 指纹（幂等用）
│   │   ├── excel.ts                      # exceljs 导出
│   │   └── sleep.ts
│   ├── types/
│   │   ├── express.d.ts                  # 扩展 Request：auth / pagination / requestId / rawBody
│   │   ├── common.d.ts                   # ApiResponse / PageResult / AuthPrincipal
│   │   └── index.ts
│   └── constants/
│       ├── enums.ts                      # 与 Prisma enum 对齐的 TS 常量（避免硬编码字符串）
│       ├── bizRules.ts                   # 运费规则、超时时长、售后期、库存预警默认值
│       └── permissions.ts                # 后台接口权限点常量（一期 RBAC 用）
├── tests/
│   ├── setup.ts                          # 测试前后：建库/migrate/truncate
│   ├── helpers/
│   │   ├── testDb.ts
│   │   ├── factories.ts                  # 造数工厂（user/product/sku/stock/order）
│   │   └── request.ts                    # supertest + token 注入封装
│   ├── unit/
│   │   ├── money.spec.ts                 # 分摊尾差、安全整数
│   │   ├── priceService.spec.ts          # 价格重算 + 恒等式
│   │   ├── orderStateMachine.spec.ts     # 合法/非法跃迁全覆盖
│   │   ├── stockService.spec.ts          # CAS SQL 影响行数分支
│   │   ├── fundService.spec.ts           # before/after 余额推演
│   │   └── idempotency.spec.ts           # 四种命中语义
│   └── integration/
│       ├── auth.spec.ts
│       ├── address.spec.ts               # 含默认地址互斥
│       ├── product.spec.ts
│       ├── cart.spec.ts                  # 含登录合并
│       ├── order.spec.ts
│       ├── order-concurrency.spec.ts     # 100 并发抢库存 10 → 成单 ≤ 10 且库存非负
│       ├── payment-callback-idempotent.spec.ts  # 重复回调 10 次仅 1 条 IN 流水
│       ├── refund.spec.ts
│       └── fund-reconcile.spec.ts        # 实付 = IN - OUT
├── logs/                                 # 运行期生成（.gitignore）
└── uploads/                              # 本地上传根目录（.gitignore）
```

---

## 4. 目录结构（前端 `web/`）

```
web/
├── index.html
├── package.json
├── vite.config.ts                        # 别名 @/、proxy /api → :3000、Element Plus 按需插件
├── tsconfig.json
├── tsconfig.node.json
├── .env.development                      # VITE_API_BASE=/api
├── .env.production                       # VITE_API_BASE=https://api.xxx.com
├── .eslintrc.cjs
├── .prettierrc
├── src/
│   ├── main.ts                           # createApp + pinia + router + Element Plus
│   ├── App.vue                           # <router-view/> + 全局 ElConfigProvider
│   ├── router/
│   │   ├── index.ts                      # createRouter（history）、组合两套路由、注册全局守卫
│   │   ├── routes/
│   │   │   ├── shop.routes.ts            # C 端路由表（meta.layout = 'shop'，meta.requiresAuth）
│   │   │   └── admin.routes.ts           # 后台路由表（meta.layout = 'admin'，meta.roles）
│   │   └── guards/
│   │       ├── authGuard.ts              # 未登录 → /login?redirect=xxx
│   │       ├── adminGuard.ts             # 非 admin scope → /admin/login
│   │       └── titleGuard.ts             # 动态标题
│   ├── layouts/
│   │   ├── ShopLayout.vue                # C 端：顶部通栏 + 分类导航 + 页脚
│   │   ├── AdminLayout.vue               # 后台：左侧菜单 + 顶栏 + 面包屑 + 内容区
│   │   ├── BlankLayout.vue               # 登录页/支付页等无框架页面
│   │   └── components/
│   │       ├── ShopHeader.vue            # LOGO/搜索/购物车角标/我的订单/用户下拉
│   │       ├── ShopFooter.vue
│   │       ├── ShopCategoryBar.vue       # 「全部分类」下拉 + 快捷入口
│   │       ├── AdminSidebar.vue          # 按权限点渲染菜单
│   │       ├── AdminHeader.vue
│   │       └── AdminBreadcrumb.vue
│   ├── api/
│   │   ├── http.ts                       # axios 实例：baseURL、超时、请求/响应拦截器
│   │   ├── interceptor.ts                # 注入 token、Idempotency-Key、401 自动刷新重试、错误 toast
│   │   ├── request.ts                    # unwrap：{code,message,data} → 抛错/返回 data
│   │   ├── types/
│   │   │   ├── common.d.ts               # PageResult<T>、ApiResponse<T>
│   │   │   ├── user.d.ts
│   │   │   ├── product.d.ts
│   │   │   ├── cart.d.ts
│   │   │   ├── order.d.ts
│   │   │   ├── fund.d.ts
│   │   │   └── admin.d.ts
│   │   ├── auth.ts
│   │   ├── user.ts
│   │   ├── address.ts
│   │   ├── category.ts
│   │   ├── product.ts
│   │   ├── cart.ts
│   │   ├── order.ts
│   │   ├── payment.ts
│   │   ├── refund.ts
│   │   ├── logistics.ts
│   │   ├── support.ts
│   │   ├── upload.ts
│   │   └── admin/
│   │       ├── adminAuth.ts
│   │       ├── adminProduct.ts
│   │       ├── adminCategory.ts
│   │       ├── adminStock.ts
│   │       ├── adminOrder.ts
│   │       ├── adminRefund.ts
│   │       ├── adminUser.ts
│   │       ├── adminFund.ts
│   │       ├── adminDashboard.ts
│   │       └── adminLog.ts
│   ├── stores/
│   │   ├── user.ts                       # token、用户信息、登录/登出/刷新
│   │   ├── cart.ts                       # C 端购物车（含未登录 localStorage 与登录合并）
│   │   ├── product.ts                    # 分类树缓存、搜索历史
│   │   ├── order.ts                      # 结算中选中的购物车条目、待支付订单
│   │   ├── address.ts
│   │   ├── app.ts                        # 全局 loading、主题、页面标题
│   │   └── admin.ts                      # 管理员信息、权限点、菜单
│   ├── views/
│   │   ├── shop/
│   │   │   ├── HomeView.vue              # /
│   │   │   ├── GoodsListView.vue         # /goods
│   │   │   ├── GoodsDetailView.vue       # /goods/:id
│   │   │   ├── SearchView.vue            # /search
│   │   │   ├── CartView.vue              # /cart
│   │   │   ├── CheckoutView.vue          # /checkout
│   │   │   ├── OrderListView.vue         # /orders
│   │   │   ├── OrderDetailView.vue       # /orders/:no
│   │   │   ├── PaymentView.vue           # /payment/:paymentNo  模拟支付页
│   │   │   ├── PayResultView.vue         # /pay-result
│   │   │   ├── LoginView.vue             # /login
│   │   │   ├── RegisterView.vue          # /register
│   │   │   └── user/
│   │   │       ├── UserCenterLayout.vue  # /user/*  左侧个人中心菜单
│   │   │       ├── MyOrderView.vue       # /user/orders
│   │   │       ├── AddressView.vue       # /user/address
│   │   │       ├── SecurityView.vue      # /user/security
│   │   │       └── FundView.vue          # /user/fund  我的资金流水（P1）
│   │   ├── admin/
│   │   │   ├── AdminLoginView.vue        # /admin/login
│   │   │   ├── DashboardView.vue         # /admin/dashboard
│   │   │   ├── goods/
│   │   │   │   ├── GoodsListView.vue     # /admin/goods
│   │   │   │   ├── GoodsEditView.vue     # /admin/goods/create | :id/edit
│   │   │   │   └── CategoryView.vue      # /admin/categories
│   │   │   ├── stock/
│   │   │   │   ├── StockListView.vue     # /admin/stock
│   │   │   │   └── StockLogView.vue      # /admin/stock-logs
│   │   │   ├── order/
│   │   │   │   ├── OrderListView.vue     # /admin/orders
│   │   │   │   └── OrderDetailView.vue   # /admin/orders/:no（含资金流水/轨迹/日志 Tab）
│   │   │   ├── refund/
│   │   │   │   └── RefundAuditView.vue   # /admin/refunds
│   │   │   ├── user/
│   │   │   │   └── UserListView.vue      # /admin/users
│   │   │   ├── fund/
│   │   │   │   ├── FundTransactionView.vue  # /admin/fund/transactions
│   │   │   │   └── FundReconcileView.vue    # /admin/fund/reconcile
│   │   │   └── system/
│   │   │       ├── AdminUserView.vue     # /admin/admins（P1）
│   │   │       ├── OperationLogView.vue  # /admin/operation-logs
│   │   │       └── IntegrationConfigView.vue  # /admin/integrations 适配器配置查看
│   │   └── error/
│   │       ├── NotFoundView.vue
│   │       └── ForbiddenView.vue
│   ├── components/
│   │   ├── common/
│   │   │   ├── MoneyText.vue             # 分 → ¥x,xxx.xx
│   │   │   ├── StatusTag.vue             # 订单/支付/退款状态徽标
│   │   │   ├── EmptyState.vue
│   │   │   ├── SkeletonList.vue
│   │   │   ├── PaginationBar.vue         # 统一分页器（对接 PageResult）
│   │   │   ├── ConfirmDialog.vue         # 破坏性操作二次确认
│   │   │   ├── UploadImage.vue           # 图片上传（白名单前端预校验 + 进度）
│   │   │   ├── CountdownTimer.vue        # 待支付 30 分钟倒计时
│   │   │   └── RegionCascader.vue        # 省市区三级级联
│   │   ├── shop/
│   │   │   ├── CategoryTree.vue          # 左侧三级分类树
│   │   │   ├── GoodsCard.vue             # 商品卡片（悬停加入购物车）
│   │   │   ├── SkuSelector.vue           # 规格选择 + 置灰不可达组合
│   │   │   ├── QuantityStepper.vue       # 数量步进器（库存上限）
│   │   │   ├── CartItemRow.vue           # 购物车行（含失效标记与价格变动角标）
│   │   │   ├── AddressCard.vue           # 地址卡片（手机号脱敏）
│   │   │   ├── AddressFormDialog.vue     # 新增/编辑地址
│   │   │   ├── OrderStatusSteps.vue      # 状态步骤条
│   │   │   ├── OrderTimeline.vue         # 订单状态时间轴
│   │   │   ├── LogisticsDrawer.vue       # 物流轨迹抽屉
│   │   │   ├── RefundApplyDialog.vue     # 申请退款（原因 + 凭证 + 金额）
│   │   │   ├── FreightSelector.vue       # 配送方式
│   │   │   └── AmountSummary.vue         # 金额明细（含积分抵扣占位行 ¥0.00）
│   │   └── admin/
│   │       ├── FilterBar.vue             # 筛选区（条件写 URL query）
│   │       ├── TableToolbar.vue          # 操作区（批量按钮）
│   │       ├── StockAdjustDrawer.vue     # 库存调整（三段口径 + 数量 + 原因）
│   │       ├── ShipDialog.vue            # 发货弹窗
│   │       ├── RefundAuditDialog.vue     # 退款审核弹窗
│   │       ├── FundTimeline.vue          # 单笔订单资金全景时间线
│   │       ├── OrderTimelinePanel.vue    # 订单轨迹
│   │       └── OperationLogDrawer.vue
│   ├── composables/
│   │   ├── useAuth.ts
│   │   ├── useCart.ts
│   │   ├── usePagination.ts              # 统一分页状态 + 与 URL query 同步
│   │   ├── useRequest.ts                 # loading/error/data 三态
│   │   ├── useCountdown.ts
│   │   └── usePermission.ts              # 后台按钮级权限判断
│   ├── utils/
│   │   ├── money.ts                      # 分 ↔ 元、格式化、千分位
│   │   ├── storage.ts                    # localStorage 封装（含未登录购物车）
│   │   ├── validate.ts                   # 手机号等前端校验规则（与后端 zod 对齐）
│   │   ├── format.ts                     # 时间、脱敏
│   │   ├── region.ts                     # 省市区静态数据
│   │   └── exportExcel.ts
│   ├── styles/
│   │   ├── index.scss
│   │   ├── variables.scss                # 配色、间距、字号（CSS 变量）
│   │   ├── reset.scss
│   │   ├── shop.scss                     # C 端全局样式
│   │   └── admin.scss                    # 后台全局样式
│   └── constants/
│       ├── enums.ts                      # 与后端对齐的状态枚举
│       └── statusMap.ts                  # 状态 → 文案/颜色映射
├── public/
│   ├── favicon.ico
│   └── images/
└── tests/                                # Vitest（P1）
```

**路由分区约定**

| 区域 | 路径前缀 | Layout | 鉴权 | 权限模型 |
| --- | --- | --- | --- | --- |
| C 端公开 | `/`、`/goods`、`/search`、`/login`、`/register` | Shop / Blank | 可选（`optionalAuth`） | 游客可读 |
| C 端私有 | `/cart`、`/checkout`、`/orders`、`/user/*`、`/payment/*` | Shop / Blank | 强制 `authGuard` | 数据行级（只查自己的） |
| 后台 | `/admin/*`（`/admin/login` 除外） | Admin / Blank | `adminGuard` | `meta.roles` + 权限点 |
| 回调内部 | 后端 `/internal/*` | — | 验签 | 前端无路由 |

---

## 5. 统一约定

### 5.1 统一响应格式

**结构定义**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `code` | number | `0` = 成功；非 0 = 业务/系统错误码（分段见 5.2） |
| `message` | string | 可直接展示给用户的中文提示 |
| `data` | any \| null | 业务数据；出错时可为错误详情对象 |
| `requestId` | string | 全链路追踪 ID，与响应头 `X-Request-Id` 一致 |
| `timestamp` | number | 服务器毫秒时间戳 |

**HTTP 状态码与 `code` 双轨制**：HTTP status 表达**语义大类**，`code` 表达**具体错误**。前端拦截器统一按 HTTP status 分派，按 `code` 做细分处理。

| HTTP | 场景 | `code` 段 |
| --- | --- | --- |
| 200 | 成功 | `0` |
| 400 | 参数校验失败 | `90xxx` |
| 401 | 未认证 / Token 失效 | `10xxx` |
| 403 | 无权限 / 越权 | `10xxx` |
| 404 | 资源不存在 / 路由不存在 | `90xxx` |
| 409 | 业务规则冲突（库存不足、状态非法、幂等冲突、唯一键冲突） | 业务段 |
| 422 | 业务恒等式校验失败（金额对不上） | `30xxx`/`60xxx` |
| 429 | 限流 | `90xxx` |
| 500 | 未捕获异常 | `90xxx` |
| 502 | 第三方服务失败 | `80xxx` |

**成功响应**

```json
{
  "code": 0,
  "message": "OK",
  "data": {
    "orderNo": "SO202401021234567890",
    "payAmount": 359700,
    "expireAt": "2024-01-02T13:04:00.000Z"
  },
  "requestId": "req_01HK8Z3F7YB2M9Q6RTVX",
  "timestamp": 1704193440000
}
```

**失败响应（业务类）**

```json
{
  "code": 50001,
  "message": "库存不足",
  "data": {
    "items": [{ "skuCode": "SKU-2024001", "required": 5, "available": 3 }]
  },
  "requestId": "req_01HK8Z3F7YB2M9Q6RTVX",
  "timestamp": 1704193440000
}
```

**失败响应（字段级校验）**

```json
{
  "code": 90001,
  "message": "参数校验失败",
  "data": {
    "errors": [
      { "field": "phone",   "message": "手机号格式不正确", "code": 90002 },
      { "field": "quantity","message": "数量必须大于 0",   "code": 90002 }
    ]
  },
  "requestId": "req_...",
  "timestamp": 1704193440000
}
```

**分页响应**（`data` 固定为分页信封）

```json
{
  "code": 0,
  "message": "OK",
  "data": {
    "list": [ { "id": 1, "name": "XXX 智能手机" } ],
    "total": 128,
    "page": 1,
    "pageSize": 20,
    "totalPages": 7
  },
  "requestId": "req_...",
  "timestamp": 1704193440000
}
```

**BigInt 序列化约定（重要）**：Prisma 的 `BigInt` 读出为 JS `bigint`，`JSON.stringify` 会抛错。统一在 `core/response.ts` 中注册 replacer：

```ts
// core/response.ts（关键片段）
export function jsonReplacer(_key: string, value: unknown) {
  return typeof value === 'bigint'
    ? (Number.isSafeInteger(Number(value)) ? Number(value) : value.toString())
    : value;
}
```
金额（分）与自增 ID 均远小于 `Number.MAX_SAFE_INTEGER`，转换无损。**禁止**在各 Service 里零散转类型。

### 5.2 异常体系与错误码

**错误类层级**

```mermaid
classDiagram
    class Error
    class AppError {
        +number code
        +number httpStatus
        +unknown data
        +boolean isOperational
        +string requestId
    }
    class ValidationError {
        +FieldError[] errors
    }
    class AuthError
    class NotFoundError
    class BusinessError
    class ConflictError
    class RateLimitError {
        +number retryAfter
    }
    class ExternalServiceError {
        +string adapter
        +string provider
    }
    Error <|-- AppError
    AppError <|-- ValidationError
    AppError <|-- AuthError
    AppError <|-- NotFoundError
    AppError <|-- BusinessError
    AppError <|-- ConflictError
    AppError <|-- RateLimitError
    AppError <|-- ExternalServiceError
```

| 错误类 | HTTP | 典型场景 |
| --- | --- | --- |
| `ValidationError` | 400 | zod 校验失败、金额恒等式不成立 |
| `AuthError` | 401 / 403 | Token 缺失过期（401）、角色不符/越权（403） |
| `NotFoundError` | 404 | 订单/商品不存在 |
| `BusinessError` | 409 | 业务规则拒绝：状态非法流转、售后期已过 |
| `ConflictError` | 409 | 唯一键冲突、并发更新冲突、幂等号参数不一致 |
| `RateLimitError` | 429 | 限流（响应头带 `Retry-After`） |
| `ExternalServiceError` | 502 | 支付/物流/短信调用失败 |

**错误码分段规则**

| 段位 | 域 | 说明 |
| --- | --- | --- |
| `0` | 成功 | — |
| `10xxx` | 用户与认证 | 注册/登录/Token/权限/用户状态 |
| `11xxx` | 收货地址 | — |
| `20xxx` | 商品分类 | — |
| `21xxx` | 商品与 SKU | — |
| `30xxx` | 购物车 | — |
| `31xxx` | 订单 | 状态机、取消、发货、确认收货 |
| `40xxx` | 支付 | 支付单、回调、关单 |
| `41xxx` | 退款 | 申请、审核、执行、重试 |
| `50xxx` | 库存 | 冻结、释放、确认、手工调整 |
| `60xxx` | 资金与对账 | 记账、余额、冲正、对账差异 |
| `61xxx` | **[v2 新增]** 余额与充值 | 余额账户、充值单、余额支付、支付密码 |
| `12xxx` | **[v2 新增]** 优惠券与促销 | 券模板、领取、使用、冻结/解冻、活动规则 |
| `70xxx` | 后台管理与权限 | 管理员、操作日志、RBAC |
| `80xxx` | 第三方适配器 | 支付/物流/客服/短信 |
| `90xxx` | 系统与通用 | 参数校验、限流、未捕获、404 |

**错误码分配表（一期全量，工程师直接取用）**

| code | HTTP | message 模板 | 说明 |
| --- | --- | --- | --- |
| 10001 | 400 | 手机号格式不正确 | — |
| 10002 | 409 | 手机号已注册 | 唯一键冲突 |
| 10003 | 401 | 账号或密码错误 | 登录失败（不区分账号是否存在，防枚举） |
| 10004 | 403 | 账号已被禁用 | — |
| 10005 | 401 | 登录已失效，请重新登录 | access token 过期 |
| 10006 | 401 | Refresh Token 无效或已吊销 | — |
| 10007 | 401 | Refresh Token 已过期 | — |
| 10008 | 401 | 检测到 Token 重放，已吊销该设备会话 | 轮换家族重放 |
| 10009 | 403 | 无权访问该资源 | 越权（数据行级） |
| 10010 | 403 | 需要更高权限 | RBAC |
| 10011 | 429 | 登录尝试过于频繁，请 15 分钟后再试 | 连续失败 5 次锁定 |
| 11001 | 404 | 收货地址不存在 | — |
| 11002 | 409 | 该地址存在进行中订单，不可删除 | — |
| 11003 | 400 | 详细地址长度需在 5-100 字之间 | — |
| 20001 | 404 | 分类不存在 | — |
| 20002 | 409 | 最多支持三级分类 | 层级超限 |
| 20003 | 409 | 该分类下存在商品，请先移除 | — |
| 21001 | 404 | 商品不存在或已下架 | — |
| 21002 | 404 | SKU 不存在 | — |
| 21003 | 409 | SKU 编码已存在 | — |
| 21004 | 409 | 同一商品下规格组合重复 | — |
| 21005 | 409 | 该商品存在未完结订单，不可删除 | — |
| 30001 | 404 | 购物车条目不存在 | — |
| 30002 | 400 | 数量必须大于 0 | — |
| 30003 | 409 | 单个 SKU 数量不可超过 999 | — |
| 30004 | 409 | 购物车条目不可超过 100 条 | — |
| 30005 | 409 | 存在失效商品，请处理后结算 | — |
| 31001 | 404 | 订单不存在 | — |
| 31002 | 409 | 订单当前状态不允许该操作 | 状态机拒绝 |
| 31003 | 409 | 订单金额校验失败 | 恒等式不成立 |
| 31004 | 409 | 订单已超时关闭 | — |
| 31005 | 409 | 超出售后期，无法申请退款 | — |
| 31006 | 409 | 订单已取消 | — |
| 31007 | 400 | 请先在 30 分钟内完成支付 | — |
| 40001 | 404 | 支付单不存在 | — |
| 40002 | 409 | 支付金额与订单金额不一致 | 回调校验失败，触发告警 |
| 40003 | 409 | 支付单已关闭 | — |
| 40004 | 409 | 支付单状态已终态 | 回调幂等命中 |
| 41001 | 404 | 退款单不存在 | — |
| 41002 | 409 | 退款金额超过可退金额 | — |
| 41003 | 409 | 存在进行中的退款单 | — |
| 41004 | 502 | 退款执行失败，请稍后重试 | 适配器失败 |
| 50001 | 409 | 库存不足 | — |
| 50002 | 409 | 库存变更冲突，请重试 | CAS 失败且重试耗尽 |
| 50003 | 400 | 库存调整必须填写原因 | — |
| 50004 | 409 | 库存调整后不能为负数 | — |
| 60001 | 409 | 资金流水记账失败 | — |
| 60002 | 409 | 不支持直接修改或删除资金流水 | 只能用冲正 |
| 60003 | 409 | 冲正流水必须关联原流水号 | — |
| 60004 | 422 | 对账不平：实付金额与流水净额不一致 | 对账告警 |
| 60005 | 409 | 手工调账必须填写原因 | — |
| **[v2]** 61001 | 404 | 余额账户不存在 | 首次访问时自动开户，正常不应出现 |
| **[v2]** 61002 | 409 | 余额不足 | 下单/支付时校验，含可用余额提示 |
| **[v2]** 61003 | 409 | 余额账户已冻结 | 风控冻结 |
| **[v2]** 61004 | 400 | 充值金额需在 1 元 ~ 50000 元之间 | 单笔限额 |
| **[v2]** 61005 | 404 | 充值单不存在或已关闭 | — |
| **[v2]** 61006 | 409 | 充值单已支付，不可重复支付 | 状态机拦截 |
| **[v2]** 61007 | 401 | 支付密码错误 | 不提示剩余次数 |
| **[v2]** 61008 | 429 | 支付密码错误次数过多，账户已临时锁定 | 复用登录锁定逻辑 |
| **[v2]** 61009 | 409 | 未设置支付密码，请先设置 | — |
| **[v2]** 61010 | 409 | 余额账户余额不可为负 | `CHECK` 约束兜底触发，属异常 |
| **[v2]** 12001 | 404 | 优惠券不存在 | — |
| **[v2]** 12002 | 409 | 优惠券已被领完 | 发放总量耗尽 |
| **[v2]** 12003 | 409 | 已达该券每人限领上限 | — |
| **[v2]** 12004 | 409 | 优惠券已使用 | — |
| **[v2]** 12005 | 409 | 优惠券已过期 | — |
| **[v2]** 12006 | 409 | 优惠券已作废 | 运营作废 |
| **[v2]** 12007 | 409 | 优惠券正被其他订单占用 | 已冻结状态 |
| **[v2]** 12008 | 422 | 订单金额未达该券使用门槛 | 含门槛提示 |
| **[v2]** 12009 | 422 | 该券不适用于订单内商品 | 适用范围不匹配 |
| **[v2]** 12010 | 409 | 一笔订单仅可使用一张优惠券 | — |
| **[v2]** 12011 | 422 | 优惠后金额不可为负 | 优惠额被 clamp 到商品金额 |
| **[v2]** 12012 | 404 | 促销活动不存在或已结束 | — |
| **[v2]** 12013 | 409 | 活动时间区间与已有活动冲突 | 同商品同时段互斥 |
| **[v2]** 12014 | 400 | 活动规则参数不合法 | 门槛/折扣率校验 |
| 70001 | 403 | 仅超级管理员可执行该操作 | — |
| 70002 | 404 | 管理员不存在 | — |
| 70003 | 409 | 敏感操作需要二次确认 | — |
| **[v2]** 70004 | 404 | 角色不存在 | RBAC |
| **[v2]** 70005 | 409 | 内置角色不可删除或修改权限 | `is_builtin=true` |
| **[v2]** 70006 | 409 | 该角色下存在管理员，不可删除 | 需先解绑 |
| **[v2]** 70007 | 409 | 不可解绑最后一个超级管理员 | 防自锁 |
| **[v2]** 70008 | 404 | 权限点不存在 | 编码非法 |
| **[v2]** 70009 | 409 | 该支付渠道配置不完整，无法启用 | 支付方式管理 |
| **[v2]** 70010 | 403 | 生产环境不允许启用模拟支付渠道 | 强制保护 |
| 80001 | 502 | 支付渠道调用失败 | — |
| 80002 | 502 | 物流查询失败 | 可降级 |
| 80003 | 502 | 短信发送失败 | 可降级 |
| 80004 | 501 | 该适配器实现尚未接入 | 占位实现 |
| 80005 | 504 | 第三方调用超时 | — |
| 90001 | 400 | 参数校验失败 | 含 `data.errors[]` |
| 90002 | 400 | 字段格式错误 | 字段级 |
| 90003 | 404 | 接口不存在 | 路由兜底 |
| 90004 | 429 | 请求过于频繁，请稍后再试 | 带 `Retry-After` |
| 90005 | 409 | 请求正在处理中，请稍后查询结果 | 幂等 PROCESSING |
| 90006 | 409 | 幂等号已被使用且参数不一致 | 幂等指纹冲突 |
| 90007 | 500 | 服务内部错误 | 未捕获 |
| 90008 | 503 | 依赖服务不可用 | Redis/DB 不可用 |

### 5.3 日志规范

**结构化字段（JSON，单行一条）**

| 字段 | 说明 |
| --- | --- |
| `ts` | ISO8601 毫秒时间戳 |
| `level` | `error` / `warn` / `info` / `http` / `debug` |
| `msg` | 简明英文/中文事件名，如 `order.created` |
| `requestId` | 全链路 ID（响应头同步返回 `X-Request-Id`） |
| `userId` / `adminId` / `role` | 操作主体 |
| `method` / `path` / `status` / `durationMs` | HTTP 维度 |
| `errCode` / `errStack` | 仅 error 级别打印 stack |
| `bizNos` | 订单号/支付单号/退款单号（便于检索） |
| `ctx` | 业务上下文对象（脱敏后） |

**requestId 全链路透传**：`middlewares/requestId.ts` 读取请求头 `X-Request-Id`（无则生成 `req_` + ULID），写入 `AsyncLocalStorage`，同时写入响应头。`core/logger/logger.ts` 从上下文自动取 `requestId`，业务代码**无需手动传递**。异步任务（BullMQ job）从 job 数据里取 `requestId` 并重建上下文。

**分层记录点**

| 层 | 记录内容 | 级别 |
| --- | --- | --- |
| 中间件（入口） | 请求进入：method/path/ip/ua/query(脱敏) | http |
| 中间件（出口） | 响应完成：status/durationMs/code | http（>1s 转 warn） |
| 控制器 | 一般不记（避免噪音） | — |
| 服务层 | 关键业务动作：`order.created`、`stock.frozen`、`fund.recorded`、`order.status_changed` | info |
| 服务层 | 业务拒绝：库存不足、状态非法 | warn |
| 事务 | 提交成功 / **回滚**（必记，含原因） | info / error |
| 适配器 | 第三方请求/响应（脱敏）、耗时、重试、失败 | info / error |
| Job | 开始/结束/处理条数/异常 | info / error |
| 全局异常 | 未捕获异常 + stack | error |

**禁止打印的敏感字段清单（`core/logger/redact.ts` 强制拦截）**

```
password, passwordHash, newPassword, oldPassword,
accessToken, refreshToken, token, authorization, cookie, set-cookie,
idCard, bankCard, cvv,
apiKey, apiSecret, privateKey, secretKey, mchKey, sign, signature,
phone, mobile（脱敏为 138****8888 后可打印）
```

**日志落地**：`logs/app-%DATE%.log`（info 及以上，保留 14 天）+ `logs/error-%DATE%.log`（error，保留 30 天）+ 控制台（开发彩色 / 生产 JSON）。

### 5.4 配置管理

**目录与加载顺序**（后者覆盖前者）：`config/default.ts` → `config/{NODE_ENV}.ts` → 环境变量（`.env`）→ 启动 zod 校验 → 冻结导出。

**环境变量命名规范**：`SHOP__` 前缀 + 大写下划线分层，例：

| 变量 | 说明 |
| --- | --- |
| `NODE_ENV` | `development` / `test` / `production` |
| `SHOP__SERVER__PORT` | 服务端口，默认 3000 |
| `SHOP__DB__URL` | `mysql://user:pass@host:3306/shop_web` |
| `SHOP__REDIS__URL` | `redis://host:6379/0` |
| `SHOP__JWT__ACCESS_SECRET` / `__ACCESS_TTL` | access token 密钥与有效期（`2h`） |
| `SHOP__JWT__REFRESH_SECRET` / `__REFRESH_TTL` | refresh token（`7d`） |
| `SHOP__JWT__ADMIN_ACCESS_SECRET` | 后台独立密钥（作用域隔离） |
| `SHOP__UPLOAD__DIR` / `__MAX_SIZE` / `__BASE_URL` | 上传目录/大小/访问前缀 |
| `SHOP__ADAPTER__PAYMENT__PROVIDER` | `mock` / `alipay` / `wechat` |
| `SHOP__ADAPTER__PAYMENT__APP_ID` 等 | 各适配器配置（见第 6 章） |
| `SHOP__ORDER__PAY_TIMEOUT_MINUTES` | 默认 30 |
| `SHOP__ORDER__AUTO_CONFIRM_DAYS` | 默认 15 |
| `SHOP__ORDER__AFTER_SALE_DAYS` | 默认 7 |
| `SHOP__FREIGHT__FREE_THRESHOLD` / `__FEE` | 9900 / 1200（分） |
| `SHOP__STOCK__DEDUCT_MODE` | `order` / `pay` |
| `SHOP__STOCK__WARNING_THRESHOLD` | 默认 10 |
| `SHOP__RATE_LIMIT__ENABLED` | true |
| `SHOP__CORS__ORIGINS` | 逗号分隔白名单 |
| `SHOP__POINT__ENABLED` | 二阶段开关，一期恒 `false` |

**启动 fail-fast 校验**（`config/env.schema.ts`，缺项/格式错直接 `process.exit(1)` 并打印缺失清单）：

```ts
// 关键片段（非完整实现）
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  SHOP__DB__URL: z.string().url(),
  SHOP__REDIS__URL: z.string().url(),
  SHOP__JWT__ACCESS_SECRET: z.string().min(32),
  SHOP__JWT__REFRESH_SECRET: z.string().min(32),
  SHOP__JWT__ADMIN_ACCESS_SECRET: z.string().min(32),
  SHOP__SERVER__PORT: z.coerce.number().int().positive().default(3000),
  // ...
});
const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) { /* 打印表格化错误并 exit(1) */ }
```

**`.env.example` 约定**：只提交 `.env.example`，键名齐全、值为占位（`<fill-me>` 或安全默认值），`.env*` 全部进 `.gitignore`。**任何真实密钥不得入库**。

### 5.5 中间件执行顺序

```mermaid
flowchart LR
    A["1 requestId<br/>生成/透传 X-Request-Id"] --> B["2 httpLogger<br/>请求进入日志"]
    B --> C["3 cors<br/>白名单校验"]
    C --> D["4 security<br/>helmet + hpp + 体大小限制"]
    D --> E["5 rateLimit<br/>Redis 令牌桶（全局/IP）"]
    E --> F["6 bodyParser<br/>json + rawBody 保留"]
    F --> G["7 auth<br/>可选/强制解析 JWT → req.auth"]
    G --> H["8 adminOnly / rbac<br/>作用域 + 角色 + 权限点"]
    H --> I["9 validate<br/>zod 校验 params/query/body"]
    I --> J["10 idempotency<br/>幂等号抢占（仅写接口）"]
    J --> K["11 pagination / upload<br/>按需挂载（路由级）"]
    K --> L["12 Controller<br/>业务处理"]
    L --> M["13 notFound<br/>兜底 404"]
    M --> N["14 errorHandler<br/>全局异常 → 统一响应"]
    N --> O["15 响应日志<br/>status + durationMs"]
```

| 序号 | 中间件 | 强制 | 说明 |
| --- | --- | --- | --- |
| 1 | `requestId` | ✅ 全局 | 必须在最前，后续日志才有链路 ID |
| 2 | `httpLogger` | ✅ 全局 | — |
| 3 | `cors` | ✅ 全局 | 非白名单直接 403（统一格式） |
| 4 | `security` | ✅ 全局 | helmet + hpp；`limit: '1mb'`（上传路由单独放宽） |
| 5 | `rateLimit` | ✅ 全局 | 全局 + IP 维度；高危接口在路由级叠加更严阈值 |
| 6 | `bodyParser` | ✅ 全局 | 回调路由需保留 `rawBody` 供验签 |
| 7 | `auth` | 路由级 | 公开接口用 `optionalAuth` |
| 8 | `adminOnly` / `rbac` | 路由级 | `/admin/*` 强制 |
| 9 | `validate` | 路由级 | 所有带参接口必挂 |
| 10 | `idempotency` | 路由级 | 下单/支付/退款/库存调整必挂 |
| 11 | `pagination` / `upload` | 路由级 | 列表接口 / 上传接口 |
| 12 | Controller | — | 业务处理 |
| 13 | `notFound` | ✅ 全局 | 兜底 → 90003 |
| 14 | `errorHandler` | ✅ 全局 | **必须最后注册** |
| 15 | 响应日志 | ✅ 全局 | 挂在 `httpLogger` 的 `finish` 钩子 |

### 5.6 上传封装

| 项 | 约定 |
| --- | --- |
| 中间件 | `middlewares/upload.ts`：multer + `diskStorage`（可切换 `memoryStorage` 走 OSS） |
| 存储驱动 | `UploadService` 抽象 `StorageDriver { put(buffer, key): Promise<url> }`，一期 `LocalDriver`（`uploads/`），二期加 `OssDriver` |
| 类型白名单 | 图片：`image/jpeg`、`image/png`、`image/webp`、`image/gif`；凭证：`application/pdf`、`image/*` |
| 扩展名白名单 | `jpg/jpeg/png/webp/gif/pdf`（**以 magic number 校验，不信任扩展名与 MIME 头**） |
| 大小限制 | 图片 ≤ 5MB；凭证/其它 ≤ 10MB；单次请求最多 9 个文件 |
| 命名规则 | `nanoid(24) + '.' + ext`（**丢弃原始文件名，防路径穿越与覆盖**） |
| 存储路径 | `uploads/{biz}/{yyyyMMdd}/{random}.{ext}`，`biz ∈ {product, avatar, voucher, category}` |
| 访问 | 静态路由 `/static` 映射到 `uploads/`，生产建议 Nginx 直出 |
| 落库 | 成功后写 `upload_files` 表，返回 `{ fileKey, url, size, mimeType }` |
| 校验失败 | `ValidationError`（90001），multer 错误在 `errorHandler` 中统一转换（含 `LIMIT_FILE_SIZE`） |

### 5.7 分页封装

| 项 | 约定 |
| --- | --- |
| 入参 | `page`（默认 1）、`pageSize`（默认 20，上限 100，超限截断为 100） |
| 归一化 | `utils/paging.ts: normalizePaging(query) → { page, pageSize, skip, take }` |
| 返回 | `{ list, total, page, pageSize, totalPages }`，`totalPages = Math.ceil(total / pageSize)` |
| 默认排序 | 每个列表显式指定，禁止无 `orderBy` 的分页（防分页漂移） |
| 深分页 | 后台导出走游标（`id > lastId`）或流式，禁止 `skip` 超过 10000 |

```ts
// repositories/BaseRepository.ts（签名）
export interface PageParams { page: number; pageSize: number; skip: number; take: number }
export interface PageResult<T> { list: T[]; total: number; page: number; pageSize: number; totalPages: number }

export async function paginate<T>(
  model: { findMany(args: any): Promise<T[]>; count(args: any): Promise<number> },
  args: { where?: any; orderBy?: any; include?: any },
  paging: PageParams,
): Promise<PageResult<T>>;   // 内部用 prisma.$transaction([count, findMany]) 保证一致性
```

### 5.8 限流封装

**实现**：`express-rate-limit` + `rate-limit-redis`（Redis 计数，多实例共享）。热点接口（下单/支付）改用 **Lua 令牌桶脚本**以获得平滑限流与原子性（脚本放 `middlewares/rateLimit.ts` 内联或 `resources/lua/token_bucket.lua`）。

**分级维度**

| 级别 | Key 组成 | 说明 |
| --- | --- | --- |
| 全局 | `shop:rl:global` | 保护整个进程（兜底熔断） |
| 按 IP | `shop:rl:ip:{ip}:{routeKey}` | 防单 IP 刷接口 |
| 按用户 | `shop:rl:user:{userId}:{routeKey}` | 登录后以用户维度为准（优先于 IP） |
| 按接口 | `routeKey` = `method:path` | 高危接口单独阈值 |

**默认阈值表**

| 场景 | 维度 | 阈值 | 窗口 | 超限响应 |
| --- | --- | --- | --- | --- |
| 全局兜底 | IP | 600 次 | 1 min | 429 + `Retry-After` |
| 默认接口 | 用户/IP | 120 次 | 1 min | 429 |
| 商品列表/搜索 | IP | 120 次 | 1 min | 429 |
| **注册** | IP | 5 次 | 1 h | 429 |
| **登录（C 端 / 后台）** | IP + 账号 | 10 次 | 15 min | 429 |
| **登录连续失败** | 账号 | 5 次 | 15 min | 423 锁定 15 min（错误码 10011） |
| **短信发送** | 手机号 | 1 次 / 60s；10 次 / 24h | — | 429 |
| **下单提交** | 用户 | 10 次 / 1 min；50 次 / 1 h | — | 429 |
| **支付发起** | 用户 | 20 次 / 1 min | — | 429 |
| **支付回调** | IP | 200 次 / 1 min | — | 429（白名单渠道 IP 可豁免） |
| **退款申请** | 用户 | 5 次 / 1 h | — | 429 |
| **文件上传** | 用户 | 20 次 / 1 min | — | 429 |
| 后台写操作 | 管理员 | 60 次 / 1 min | — | 429 |
| 后台导出 | 管理员 | 10 次 / 1 h | — | 429 |

**Redis 不可用降级**：限流失败**放行**（fail-open）并打 `warn` 日志，避免 Redis 故障导致全站不可用；同时对全局兜底降级为内存计数。

### 5.9 Redis 使用边界（**工程师必读，防误用**）

```mermaid
flowchart LR
    subgraph REDIS["Redis（辅助，非权威，可丢）"]
        R1["限流计数"]
        R2["幂等前置快拦"]
        R3["热点 SKU 互斥锁"]
        R4["分类树 / 商品 / 物流轨迹缓存"]
        R5["BullMQ 队列与 Job 状态"]
        R6["分布式选主锁"]
    end
    subgraph MYSQL["MySQL（权威，唯一真相）"]
        M1["订单与订单行"]
        M2["库存三段数量 + version"]
        M3["资金流水 + 账户余额"]
        M4["支付单 / 退款单状态"]
        M5["订单状态轨迹"]
        M6["幂等记录（唯一索引）"]
        M7["库存流水 / 操作日志"]
    end
```

| 场景 | 用 Redis？ | 说明 |
| --- | --- | --- |
| 限流计数 | ✅ | 丢了只是阈值重置，可接受 |
| 幂等前置拦截 | ✅ 辅助 | **权威仍是 MySQL `idempotency_records` 唯一索引**；Redis 只做快速失败，减少 DB 压力 |
| 热点 SKU 互斥锁 | ✅ | 只用于**削峰排队**，减少 CAS 重试风暴；**锁失效不产生超卖**，因为最终判定靠 DB CAS |
| 分类树 / 商品详情 / SKU 价格缓存 | ✅ | 短 TTL（分类树 10min、商品 5min、价格 60s），写操作主动失效；**不缓存库存可售数用于扣减** |
| 物流轨迹缓存 | ✅ | 30 min TTL，查失败降级返回空 |
| 定时任务调度 / 选主 | ✅ | BullMQ + Redlock |
| **库存扣减与可售判定** | ❌ **禁止** | 必须走 MySQL 事务内 CAS 条件更新 |
| **订单状态流转** | ❌ **禁止** | 必须走 MySQL 事务内条件更新 |
| **资金记账与余额** | ❌ **禁止** | 必须走 MySQL 事务内 `FOR UPDATE` 锁账户 + 流水 |
| **最终幂等判定** | ❌ **禁止** | 必须走 MySQL 唯一索引 |
| 会话（登录态） | ❌ | JWT 无状态 + refresh token 存 MySQL |
| **[v2]** 后台权限点集合 | ✅ 辅助 | 60s TTL；**敏感权限（`is_sensitive`）绕过缓存实时查库**；Redis 不可用时降级直查 DB（**不降级为放行**） |
| **[v2]** 支付方式列表 | ✅ | 60s TTL，后台变更主动失效；仅用于 C 端展示，**下单时仍需查库校验渠道可用** |
| **[v2]** 券模板可领列表 | ✅ | 60s TTL；**领取时的库存判定必须走 DB 原子扣减**（`issued_count < total_count` 条件更新），不信缓存 |
| **[v2] 优惠券状态与核销** | ❌ **禁止** | 券的冻结/解冻/核销必须走 MySQL 事务内条件更新，与订单同事务 |
| **[v2] 用户余额可用额判定** | ❌ **禁止** | 同「资金记账与余额」，必须 `FOR UPDATE` |

**Key 命名规范**：`shop:{domain}:{...}`，全部带 TTL（锁除外，锁用 `SET NX PX` + 续约）。

| Key | TTL | 用途 |
| --- | --- | --- |
| `shop:rl:{scope}:{id}:{route}` | 窗口时长 | 限流 |
| `shop:idem:{scope}:{key}` | 与幂等有效期一致 | 幂等前置快拦 |
| `shop:lock:sku:{skuId}` | 10s（自动续约） | 热点 SKU 锁 |
| `shop:lock:job:{jobName}` | 55s | 定时任务选主 |
| `shop:cache:category:tree:v{n}` | 10 min | 分类树 |
| `shop:cache:product:{id}:v{n}` | 5 min | 商品详情 |
| `shop:cache:sku:price:{id}` | 60s | SKU 价格（**只读展示，不用于扣减**） |
| `shop:cache:logistics:{no}` | 30 min | 物流轨迹 |
| **[v2]** `shop:rbac:perms:{adminUserId}` | 60s | 管理员权限点集合（敏感权限不走此缓存） |
| **[v2]** `shop:cache:pay:methods` | 60s | 已启用支付方式列表（后台变更主动 DEL） |
| **[v2]** `shop:cache:coupon:available:{userId}` | 60s | 可领券列表 |
| **[v2]** `shop:lock:account:{accountId}` | 10s（自动续约） | 余额账户削峰锁（**权威仍是 `FOR UPDATE`**） |

### 5.10 幂等封装（服务层约定）

| 项 | 约定 |
| --- | --- |
| 传递 | 请求头 `Idempotency-Key: <UUID v4>`；下单/支付/退款/库存调整**必传**（缺失 → 400） |
| 服务端兜底 | 未传时用确定性 Key：如支付回调固定 `PAY_CALLBACK:{outTradeNo}` |
| `scope` | `业务类型 + 主体ID`，例：`ORDER_CREATE:{userId}`、`STOCK_ADJUST:{adminId}` |
| 存储 | MySQL `idempotency_records`，唯一索引 `(scope, idempotency_key)` |
| 指纹 | `sha256(JSON.stringify(规范化 body))`，防同 Key 不同参 |
| 有效期 | 订单创建 24h；支付/退款 7d |

**四种命中语义**

| 记录状态 | 指纹 | 行为 |
| --- | --- | --- |
| `SUCCESS` | 一致 | 直接返回首次 `response_snapshot`（HTTP 状态与 body 完全一致） |
| `SUCCESS` | 不一致 | `409` + code `90006` |
| `PROCESSING` | — | `409` + code `90005`，提示稍后查询 |
| `FAILED` | — | 允许重新执行（覆盖记录） |
| 无记录 | — | 插入 `PROCESSING` 抢占（唯一索引冲突即视为并发命中） |

**并发抢占实现要点**：`INSERT` 与业务执行在**同一事务**内；若业务失败则事务回滚，幂等记录一并消失（不残留 `PROCESSING`）。`response_snapshot` 在事务提交**前**更新为 `SUCCESS`。

### 5.11 金额处理公约

| 项 | 约定 |
| --- | --- |
| 存储 | `BIGINT`，单位「分」，**永不出现小数金额字段** |
| 读取 | Prisma 返回 `bigint`，统一由 `jsonReplacer` 转 `number` |
| 计算 | `MoneyUtil` 内部用 `bigint` 四则运算；除不尽时按权重分摊 + 尾差计入最大项 |
| 比例 | 万分比整数（85 折 = `8500`） |
| 传输 | API 出参一律「分」（number）；前端 `MoneyText` 转元展示 |
| 断言 | `MoneyUtil.assertAmount(v)`：`Number.isSafeInteger(v) && v >= 0`，不满足直接抛错 |

#### [v2 新增] 金额恒等式族（**每条都要在代码中断言，不满足即抛错拒绝下单**）

优惠券上线后金额链路变长，必须用一组恒等式把它锁死。`PriceService` 在返回结果前逐条 `assert`，任一条不成立立即抛 `BusinessError`，**绝不允许带着算错的金额进入下单事务**。

| # | 恒等式 | 说明 |
| --- | --- | --- |
| E1 | `goods_amount = Σ(order_items.price × quantity)` | 商品金额 = 各行原价小计之和（**用服务端重算的价，不信前端**） |
| E2 | `discount_amount = promo_discount + coupon_discount` | 总优惠 = 活动优惠 + 券优惠（一期一单一券） |
| E3 | `discount_amount = Σ(order_items.discount_amount)` | **优惠必须完整分摊到行**，尾差计入金额最大的行。这条是部分退款能否算清的前提 |
| E4 | `pay_amount = goods_amount - discount_amount + freight_amount` | 应付总额。**v1.1 取消混合支付后不再有余额抵扣项** |
| E5 | `discount_amount ≤ goods_amount` | 优惠不得超过商品金额（**运费不参与优惠**），超出则 clamp 并记警告 |
| E6 | `pay_amount ≥ 0` 且 `pay_amount ≥ freight_amount` | 极端优惠下应付不为负，且至少覆盖运费 |
| E7 | `Σ(order_items.actual_amount) = goods_amount - discount_amount` | 行实付之和 = 商品金额 - 优惠，其中 `actual_amount = price × quantity - discount_amount` |
| E8 | 退款：`refund_amount ≤ pay_amount - already_refunded` | 累计退款不得超过实付 |
| E9 | 部分退款：`refund_amount = Σ(退款行 actual_amount) + 分摊运费` | 按行退已分摊优惠，**不是按原价退** |
| E10 | 对账：`pay_amount = Σ(fund_transactions IN) - Σ(fund_transactions OUT)`（按 `order_no` 聚合） | 资金流水净额必须等于实付，见 `04-flows.md` F11 |

**分摊算法**（`MoneyUtil.allocate(total, weights[])`）：按各行 `price × quantity` 为权重分摊优惠，用 `bigint` 向下取整，**尾差（total - Σ已分配）加到权重最大的那一行**。这样保证 E3 严格成立，不产生一分钱漂移。

> **反模式警告**：不要在展示层用元为单位重算金额再回传（浮点会引入 0.01 误差）；不要把优惠只记在订单头而不分摊到行（部分退款时无法确定该退多少）。这两个坑在优惠券系统里最常见。

---

## 6. 第三方适配器层设计

### 6.1 统一接口契约

```ts
// integrations/AdapterResult.ts
export interface AdapterResult<T = unknown> {
  success: boolean;                 // 业务是否成功（非网络层）
  code: string;                     // 适配器自有码，成功为 'OK'
  message: string;                  // 可展示文案
  data: T | null;                   // 结构化结果
  raw: unknown;                     // 原始响应（落 integration_call_logs，脱敏后）
}

// integrations/AdapterFactory.ts
export type AdapterType = 'payment' | 'logistics' | 'support' | 'sms';
export interface AdapterFactory {
  get<T>(type: AdapterType): T;     // 进程内单例缓存；provider 变更需重启或调用 reload()
  reload(): void;
}
```

**统一行为（由 `httpClient.ts` 兜底，各实现不重复写）**

| 能力 | 约定 |
| --- | --- |
| 超时 | 连接 3s，读取 5s（可配 `adapter.<type>.timeoutMs`） |
| 重试 | 默认 2 次，仅对 **幂等接口**（查询类、退款按单号幂等）重试；下单类不重试 |
| 退避 | 指数退避 `200ms * 2^n` + 抖动 |
| 熔断 | 同 provider 连续 10 次失败 → 熔断 60s，期间快速失败（P1） |
| 降级 | `ExternalServiceError` 由**调用方**决定是否降级（如物流失败只影响轨迹展示，不阻断订单） |
| 调用日志 | 每次调用写 `integration_call_logs`（请求/响应脱敏、耗时、成功与否、重试次数） |
| 失败语义 | **不抛裸异常**，一律返回 `AdapterResult{success:false}`；网络异常包成 `ExternalServiceError` 抛出，由 Service 捕获 |

### 6.2 支付适配器 `PaymentAdapter`

```ts
export interface CreatePaymentInput {
  paymentNo: string;      // 我方支付单号
  orderNo: string;
  subject: string;
  amount: number;         // 分
  currency: string;       // 'CNY'
  expireAt: Date;
  notifyUrl: string;
  returnUrl: string;
  clientIp?: string;
  metadata?: Record<string, unknown>;
}
export interface CreatePaymentData { payUrl: string; qrCodeUrl?: string; channelTradeNo?: string; expireAt: Date }

export interface PaymentNotify {          // 回调解析后的标准化结构
  paymentNo: string;      // out_trade_no
  channelTradeNo: string; // trade_no
  tradeStatus: 'SUCCESS' | 'CLOSED' | 'FAILED' | 'REFUND';
  amount: number;         // 分
  paidAt: Date;
  raw: unknown;
}

export interface RefundInput {
  refundNo: string; paymentNo: string; orderNo: string;
  amount: number; reason: string; notifyUrl: string;
}
export interface RefundData { channelRefundNo: string; status: 'PROCESSING' | 'SUCCESS' | 'FAILED'; failReason?: string }

export interface PaymentAdapter {
  readonly provider: string;
  createPayment(input: CreatePaymentInput): Promise<AdapterResult<CreatePaymentData>>;
  queryPayment(paymentNo: string): Promise<AdapterResult<{ status: string; amount: number; paidAt?: Date }>>;
  refund(input: RefundInput): Promise<AdapterResult<RefundData>>;
  closePayment(paymentNo: string): Promise<AdapterResult<{ closed: boolean }>>;
  verifyCallback(rawBody: string, headers: Record<string, string>): Promise<AdapterResult<PaymentNotify>>;
}
```

**Mock 实现行为**（一期交付要点）

| 方法 | mock 行为 |
| --- | --- |
| `createPayment` | 生成 `payUrl = ${webBase}/payment/{paymentNo}`，落 `payments.qrcode_url` |
| `queryPayment` | 直接读本地 `payments` 表状态返回 |
| `refund` | 直接返回 `{ status: 'SUCCESS', channelRefundNo: 'MOCKRF...' }`，可配 `mockRefundFailRate` 模拟失败 |
| `closePayment` | 本地标记 `CLOSED` |
| `verifyCallback` | mock 模式下**校验内部 HMAC 签名**（`X-Mock-Signature`，用 `JWT.ACCESS_SECRET` 派生），防止任何人伪造回调；生产模式强制验签 |

**模拟支付页流程**：前端 `/payment/:paymentNo` 展示订单摘要 → 点击「确认支付」→ 调 `POST /api/payments/:paymentNo/mock-pay` → 后端构造回调请求（带 HMAC 签名，带 `Idempotency-Key`）打到 `POST /internal/callbacks/payment/mock` → 走与真实回调**完全相同**的处理链路。**关键：mock 必须走回调链路，不能直接在业务里改状态**，否则真实渠道接入时会漏掉验签与幂等环节。

### 6.3 物流 / 客服 / 短信适配器

```ts
export interface LogisticsAdapter {
  readonly provider: string;
  queryTrace(input: { companyCode: string; trackingNo: string; phone?: string }):
    Promise<AdapterResult<{ companyCode: string; trackingNo: string; state: string; traces: TraceNode[] }>>;
  subscribe?(input: { companyCode: string; trackingNo: string; callbackUrl: string }): Promise<AdapterResult<{ subscribed: boolean }>>;
}

export interface SupportAdapter {
  readonly provider: string;
  createSession(input: { userId?: number; orderNo?: string; nickname: string }): Promise<AdapterResult<{ sessionId: string }>>;
  sendMessage(input: { sessionId: string; from: 'user' | 'staff' | 'system'; contentType: 'TEXT' | 'IMAGE'; content: string }): Promise<AdapterResult<{ messageId: string; sentAt: Date }>>;
  getMessages(input: { sessionId: string; sinceId?: string; limit?: number }): Promise<AdapterResult<{ messages: SupportMessage[] }>>;
  closeSession(input: { sessionId: string }): Promise<AdapterResult<{ closed: boolean }>>;
}

export interface SmsAdapter {
  readonly provider: string;
  sendVerifyCode(input: { phone: string; scene: 'REGISTER' | 'LOGIN' | 'RESET_PWD'; code: string }): Promise<AdapterResult<{ bizId: string }>>;
  sendNotify(input: { phone: string; templateCode: string; params: Record<string, string> }): Promise<AdapterResult<{ bizId: string }>>;
}
```

> 短信 `checkCode` 校验**不放在适配器**（验证码存储与校验属于业务与限流范畴），由 `AuthService` + Redis 完成，适配器只负责「发」。

### 6.4 工厂与配置切换

```yaml
# config/default.ts（示意）
adapter:
  payment:   { provider: mock,     timeoutMs: 5000, retry: 2 }
  logistics: { provider: mock,     timeoutMs: 5000, retry: 2 }
  support:   { provider: mock,     timeoutMs: 5000, retry: 1 }
  sms:       { provider: mock,     timeoutMs: 3000, retry: 1, fixedCode: '123456' }
```

```ts
// integrations/registry.ts（要点）
export const REGISTRY = {
  payment:   { mock: MockPaymentAdapter, alipay: AlipayPaymentAdapter, wechat: WechatPaymentAdapter },
  logistics: { mock: MockLogisticsAdapter, kuaidi100: Kuaidi100LogisticsAdapter, kuaidiniao: KuaidiniaoLogisticsAdapter },
  support:   { mock: MockSupportAdapter, qiyu: QiyuSupportAdapter },
  sms:       { mock: MockSmsAdapter, aliyun: AliyunSmsAdapter, tencent: TencentSmsAdapter },
} as const;
// AdapterFactory.get('payment')：读 config.adapter.payment.provider → new REGISTRY.payment[provider](cfg) → 单例缓存
```

**切换方式**：仅改环境变量 `SHOP__ADAPTER__PAYMENT__PROVIDER=alipay` 并补齐对应密钥，**零业务代码改动**。缺失密钥时启动校验直接 fail-fast。

### 6.5 真实服务商配置项清单与接入步骤

#### 6.5.1 支付 — 支付宝（当面付 / 电脑网站支付）

| 配置项 | 环境变量 | 说明 |
| --- | --- | --- |
| `appId` | `SHOP__ADAPTER__PAYMENT__APP_ID` | 开放平台应用 ID |
| `privateKey` | `...__PRIVATE_KEY` | 应用私钥（PKCS8，RSA2 2048） |
| `alipayPublicKey` | `...__ALIPAY_PUBLIC_KEY` | 支付宝公钥（验签用，勿与应用公钥混淆） |
| `gatewayUrl` | `...__GATEWAY_URL` | `https://openapi.alipay.com/gateway.do`（沙箱 `openapi-sandbox.dl.alipaydev.com`） |
| `notifyUrl` | `...__NOTIFY_URL` | `https://<domain>/internal/callbacks/payment/alipay` |
| `returnUrl` | `...__RETURN_URL` | 前端同步跳转地址 |
| `signType` | `...__SIGN_TYPE` | `RSA2` |
| `sandbox` | `...__SANDBOX` | 是否沙箱 |
| `mchId`(可选) | `...__MCH_ID` | 间连商户场景 |

**接入步骤**：
1. 支付宝开放平台 → 创建「网页/移动应用」→ 获得 `appId` → 签约「电脑网站支付」或「当面付」。
2. 用支付宝密钥工具生成应用密钥对（RSA2/2048），上传应用公钥换取**支付宝公钥**。
3. 配置应用网关与**异步通知地址**（必须公网 HTTPS，且不能有登录态拦截）。
4. 安装 `alipay-sdk`（官方 Node SDK）或自签（推荐 SDK 减少出错）。
5. 实现 `AlipayPaymentAdapter`：`createPayment` → `alipay.trade.page.pay` / `alipay.trade.precreate`；`refund` → `alipay.trade.refund`；`closePayment` → `alipay.trade.close`；`queryPayment` → `alipay.trade.query`。
6. `verifyCallback`：① 用支付宝公钥验 `sign`（**必须验**）；② 校验 `app_id` 与 `total_amount` 与本地支付单一致；③ 校验 `out_trade_no` 存在；④ 返回 `success` 字符串给支付宝，否则支付宝会重复通知（最多 8 次，间隔递增）。
7. 联调：沙箱钱包 → 沙箱支付 → 观察 `integration_call_logs` 与 `fund_transactions` 是否正确落一条 `IN`。
8. 上线前：公网回调可达性测试、金额单位测试（元 ↔ 分，注意支付宝用元且保留两位小数）、重复通知幂等测试。

#### 6.5.2 支付 — 微信支付（Native / JSAPI / H5）

| 配置项 | 环境变量 | 说明 |
| --- | --- | --- |
| `appId` | `...__APP_ID` | 公众号/小程序/移动应用 appid |
| `mchId` | `...__MCH_ID` | 商户号 |
| `apiV3Key` | `...__API_V3_KEY` | APIv3 密钥（32 字符，解密回调 resource） |
| `serialNo` | `...__SERIAL_NO` | 商户 API 证书序列号 |
| `privateKey` | `...__PRIVATE_KEY` | 商户 API 证书私钥（`apiclient_key.pem` 内容） |
| `certPem` / 平台证书 | `...__PLATFORM_CERT` | 微信支付平台证书（验签） |
| `notifyUrl` | `...__NOTIFY_URL` | `https://<domain>/internal/callbacks/payment/wechat` |
| `certPath` | `...__CERT_PATH` | 退款等需双向证书的接口（退款 v3 已不需要） |

**接入步骤**：
1. 微信支付商户平台 → 绑定商户号与 appid 关联 → 设置 APIv3 密钥。
2. 商户平台下载并申请 API 证书 → 得到 `apiclient_cert.pem` / `apiclient_key.pem` / 序列号。
3. 实现 `WechatPaymentAdapter`：统一下单 v3 `POST /v3/pay/transactions/native`（返回 `code_url`，前端生成二维码）；`refund` → `POST /v3/refund/domestic/refunds`（需 `Out-Request-No` 幂等）；`closePayment` → `POST /v3/pay/transactions/out-trade-no/{no}/close`。
4. `verifyCallback`：① 校验 `Wechatpay-Signature` / `Wechatpay-Timestamp` / `Wechatpay-Nonce` / `Wechatpay-Serial` 四要素（用平台证书验签）；② 校验 timestamp 5 分钟内（防重放）；③ 用 `apiV3Key` AES-GCM 解密 `resource`；④ 校验金额与商户号。
5. 注意：微信回调**要求 5 秒内应答**，处理逻辑必须异步化（回调接口先落 `integration_call_logs` 并立即返回，实际入账交给 BullMQ job）；或同步但保证极快（推荐先落队再处理）。
6. 退款回调单独端点：`/internal/callbacks/refund/wechat`。

#### 6.5.3 物流查询 — 快递 100 / 快递鸟

| 配置项 | 环境变量 | 说明 |
| --- | --- | --- |
| `provider` | `SHOP__ADAPTER__LOGISTICS__PROVIDER` | `kuaidi100` / `kuaidiniao` |
| `apiKey` | `...__API_KEY` | 快递100 = `customer` + `key`；快递鸟 = `EBusinessID` + `AppKey` |
| `customer` | `...__CUSTOMER` | 快递100 客户编号 |
| `queryUrl` | `...__QUERY_URL` | 实时查询接口地址 |
| `subscribeUrl` | `...__SUBSCRIBE_URL` | 订阅推送回调地址（可选） |
| `companyMapPath` | — | 快递公司编码映射表（`constants/` 内维护） |

**接入步骤**：
1. 注册企业账号 → 实名认证 → 购买查询套餐 → 获取 `key` / `AppKey`。
2. 维护**快递公司编码映射表**（我方 `logistics_company.code` ↔ 渠道 `com` 编码），放 `src/constants/logisticsCompany.ts`。
3. 实现 `queryTrace`：POST 表单（快递100）/ JSON（快递鸟），注意快递鸟需 `RequestData` + `DataSign`（`MD5(RequestData+AppKey)` 后 base64+urlencode）。
4. 结果**归一化**到统一 `TraceNode{ time, status, desc }` 结构，与 mock 完全一致（保证上层无感）。
5. 降级：查询失败/超限返回 `{success:false}`，`LogisticsQueryService` 返回空轨迹并在前端提示「暂无物流信息」，**不阻断订单流程**。
6. 缓存：同一单号 30 分钟内复用缓存；已签收的轨迹永久缓存（不变数据）。

#### 6.5.4 客服 — 网易七鱼 / 自研

| 配置项 | 环境变量 | 说明 |
| --- | --- | --- |
| `provider` | `SHOP__ADAPTER__SUPPORT__PROVIDER` | `mock` / `qiyu` / `self` |
| `appKey` | `...__APP_KEY` | 七鱼 appKey |
| `appSecret` | `...__APP_SECRET` | 七鱼 appSecret |
| `apiUrl` | `...__API_URL` | `https://qiyukf.com/openapi/...` |
| `webUrl` | `...__WEB_URL` | 前端嵌入客服组件地址 |
| `staffId` | `...__STAFF_ID` | 默认接待客服 ID |

**接入步骤**：
1. 七鱼后台 → 开放平台 → 创建应用 → 获得 `appKey` / `appSecret`。
2. 实现 `createSession`（七鱼 `openapi/session/create`）、`sendMessage`、`getMessages`（分页拉取历史）、`closeSession`。
3. 前端两种形态：① 直接嵌入七鱼 Web SDK（推荐，会话在七鱼侧）；② 自研前端 + 适配器代理（会话在我方）。**一期 mock 采用形态②**，真实接入时切形态①只需替换 `SupportService` 返回 `webUrl` 供前端跳转。
4. 消息落库：无论 mock 还是真实，我方均存一份（便于与订单关联展示），脱敏手机号后再上传七鱼。

#### 6.5.5 短信 — 阿里云 / 腾讯云

| 配置项 | 环境变量 | 说明 |
| --- | --- | --- |
| `provider` | `SHOP__ADAPTER__SMS__PROVIDER` | `mock` / `aliyun` / `tencent` |
| `accessKeyId` | `...__ACCESS_KEY_ID` | — |
| `accessKeySecret` | `...__ACCESS_KEY_SECRET` | — |
| `signName` | `...__SIGN_NAME` | 已审核签名 |
| `templateCode` | `...__TEMPLATE_CODE_{SCENE}` | 按场景：注册/登录/支付成功/发货通知 |
| `region` | `...__REGION` | 阿里云 `cn-hangzhou`；腾讯云 `ap-guangzhou` |
| `sdkAppId` | `...__SDK_APP_ID` | 腾讯云专用 |

**接入步骤**：
1. 控制台 → 申请短信签名（需营业执照/网站备案）→ 申请模板（模板变量需与代码一致）。
2. 安装官方 SDK（`@alicloud/dysmsapi20170525` / `tencentcloud-sdk-nodejs-sms`）。
3. 实现 `sendVerifyCode`（模板变量 `code`）与 `sendNotify`（模板变量随场景）。
4. 频控：除适配器外，**业务层必须做 Redis 频控**（60s/次、10 次/天），避免被刷爆。
5. 失败降级：短信失败**不影响主流程**（注册/下单照常成功），仅记录 `integration_call_logs` 并告警。

#### 6.5.6 [v2 新增] 支付 — 银行卡（**含选型对比与推荐**）

> 客户变更③明确要求「还需接入银行卡」。银行卡不像支付宝/微信只有一条路，共三条可选路径，**资质门槛与接入周期差异极大**，故先做选型对比。

**路径对比**

| 维度 | ① 直连银联全渠道（UnionPay） | ② 聚合支付服务商（拉卡拉 / 收钱吧 / Ping++） | ③ 支付宝/微信内的绑卡快捷 |
| --- | --- | --- | --- |
| 商户资质 | **最高**：企业营业执照 + 对公户 + 行业许可，需通过银联/收单机构进件审核 | 中：营业执照 + 对公户，服务商代为进件 | **最低**：已有支付宝/微信商户号即可，无需额外进件 |
| 接入周期 | **4~8 周**（含进件、联调、生产验证） | 1~2 周 | **0**（已在 6.5.1 / 6.5.2 覆盖） |
| 费率 | 最低（0.5%~0.6%，可议） | 中（0.6%~0.8%，含服务商抽成） | 同支付宝/微信标准费率 |
| 卡种覆盖 | 借记卡 + 信用卡 + 境外卡，覆盖最全 | 依服务商能力，主流卡种全覆盖 | 仅用户已绑定在支付宝/微信内的卡 |
| 退款能力 | 完整（支持部分退款、原路退回） | 完整（服务商代理） | 完整 |
| 分账能力 | 支持（需单独开通） | 多数支持 | 支持（需开通分账） |
| 对账文件 | 银联标准对账文件，T+1 下载，格式固定 | 服务商 API / 文件，格式各异 | 渠道账单 API |
| 技术复杂度 | **高**：公私钥体系、报文加签（PKCS#7）、前置/后台通知双通道、字段众多 | 中：REST + JSON，SDK 完善 | 低：已实现 |
| 独立成本 | 需自建卡号输入页（**PCI-DSS 合规压力**）或用银联托管页 | 服务商托管收银台，无卡号落地 | 无 |

**推荐：② 聚合支付服务商（首选拉卡拉或收钱吧），一期先接 mock 保留切换位**

理由：
1. **① 的进件周期（4~8 周）远超一期工期**，且银联报文规范复杂度是支付宝的数倍，会成为一期唯一的关键路径阻塞项；
2. **卡号绝不落我们的库**。走服务商托管收银台，我们只拿到 `payUrl` 跳转，规避 PCI-DSS 合规义务 —— 这是自建卡号页最容易被低估的成本；
3. 费率差（约 0.1~0.2%）在一期交易量下的绝对金额远小于开发与合规成本；
4. 适配器模式已把差异隔离在 `BankCardAdapter` 内，**二期若交易量上来要换直连银联，只改这一个类**，业务代码零改动。

> **给客户的决策提示**：若你已持有银联进件资质或已有合作收单机构，则直接走 ①，此时把本节配置项换成银联的即可，其余设计不变。

**配置项清单（以聚合服务商为例，字段名已抽象）**

| 配置项 | 环境变量 | 说明 |
| --- | --- | --- |
| `provider` | `SHOP__ADAPTER__PAYMENT__BANKCARD__PROVIDER` | `mock` / `lakala` / `shouqianba` / `pingxx` / `unionpay` |
| `merchantNo` | `...__BANKCARD__MERCHANT_NO` | 商户号（服务商分配） |
| `termNo` | `...__BANKCARD__TERM_NO` | 终端号（线上交易多为固定值，见 Q-B11） |
| `appId` | `...__BANKCARD__APP_ID` | 应用/渠道标识 |
| `privateKey` | `...__BANKCARD__PRIVATE_KEY` | 商户私钥（RSA2 / SM2，按服务商要求） |
| `platformPublicKey` | `...__BANKCARD__PLATFORM_PUBLIC_KEY` | 平台公钥（验签用） |
| `gatewayUrl` | `...__BANKCARD__GATEWAY_URL` | 网关地址（沙箱 / 生产分离） |
| `notifyUrl` | `...__BANKCARD__NOTIFY_URL` | `https://<domain>/internal/callbacks/payment/bankcard` |
| `returnUrl` | `...__BANKCARD__RETURN_URL` | 支付完成前端跳回地址 |
| `signType` | `...__BANKCARD__SIGN_TYPE` | `RSA2` / `SM2`（国密场景） |
| `sandbox` | `...__BANKCARD__SANDBOX` | 是否沙箱 |

**接入步骤**

1. 选定服务商 → 提交营业执照、对公账户、法人身份证、经营场景说明 → 服务商代进件（1~2 周）。
2. 拿到商户号/终端号/密钥对 → 配置沙箱环境 → 用服务商提供的测试卡号联调。
3. 实现 `BankCardAdapter`：`createPayment`（返回托管收银台 `payUrl`）、`queryPayment`、`refund`、`closePayment`、`verifyCallback`。
4. **回调统一走异步链路**（见 §10）：验签 → 落 `integration_call_logs` → 投递 BullMQ → 立即应答。
5. 生产验证：小额真实支付 → 验证退款 → **下载 T+1 对账文件与 `fund_transactions` 核对**（对账口径见 `04-flows.md` F11）。
6. 上线前在后台「支付方式管理」（§6.7）开启该渠道；未开启时 C 端结算页不展示。

> **合规红线**：无论走哪条路径，**卡号、CVV、有效期、密码一律不得进入我们的日志、数据库、缓存**。`integration_call_logs` 的请求体入库前必须脱敏（见 §5.3 敏感字段清单，新增 `cardNo` / `cvv` / `expiryDate`）。

### 6.6 [v2 新增] 支付渠道路由

四个真实渠道 + mock 并存后，`PaymentService` **不直接依赖任何具体渠道**，由路由层按 `pay_method` 分发：

```ts
// integrations/payment/PaymentRouter.ts
type PayMethod = 'BALANCE' | 'ALIPAY' | 'WECHAT' | 'BANKCARD' | 'MOCK';

class PaymentRouter {
  // 余额支付不走适配器：它是内部账务操作，由 BalanceService 在本地事务内完成
  resolve(method: PayMethod): PaymentAdapter | null {
    if (method === 'BALANCE') return null;          // 调用方据此走内部账务分支
    return this.factory.get(config.adapter.payment[method].provider);
  }
}
```

**关键约定（工程师必读）**

| 项 | 约定 |
| --- | --- |
| 余额支付的定位 | **不是第三方渠道**，不走适配器、不产生外部 HTTP、无回调。在下单事务内直接扣减 `fund_accounts` 并记流水（`04-flows.md` F15） |
| 渠道可用性判定 | 下单时校验三层：① 该渠道在 `payment_methods` 中 `enabled=true`；② 配置完整（启动时 fail-fast 已校验）；③ 余额支付额外校验 `balance >= pay_amount` |
| 单一支付 | **v1.1 取消混合支付**：`pay_method` 单值，不存在一单多渠道。路由结果唯一 |
| 降级 | 某渠道适配器初始化失败 → 该渠道自动置为不可用并告警，**不影响其他渠道**；不允许静默 fallback 到 mock（生产环境 mock 必须显式关闭） |

### 6.7 [v2 新增] 后台支付方式管理

对应表 `payment_methods`（见 `03-database.md`）。后台可配置：

| 能力 | 说明 | 权限点 |
| --- | --- | --- |
| 启停渠道 | `enabled` 开关，关闭后 C 端结算页立即不展示（Redis 缓存 `pay:methods` TTL 60s + 变更主动失效） | `pay:channel:toggle` |
| 展示名与图标 | `display_name` / `icon`，支持「微信支付」改成「微信」这类文案调整 | `pay:channel:update` |
| 排序 | `sort`，控制结算页单选列表顺序（Q-B17 支付方式是否预选：**推荐默认预选排序最靠前的可用渠道**，余额不足时跳过余额项） | `pay:channel:update` |
| 单笔限额 | `min_amount` / `max_amount`（分），下单时校验，超限提示换渠道 | `pay:channel:update` |
| 查看 | 渠道列表与配置状态（**密钥类字段一律不回显**，只显示「已配置/未配置」） | `pay:channel:list` |

> **生产环境保护**：`mock` 渠道在 `NODE_ENV=production` 下**强制不可启用**（启动时校验，配置里开了也拒绝启动），防止误用模拟支付造成真实订单无资金入账。

---

## 7. 安全设计

### 7.1 认证（JWT）

```mermaid
sequenceDiagram
    participant C as 客户端
    participant A as AuthController
    participant S as AuthService
    participant T as TokenService
    participant DB as MySQL

    C->>A: POST /api/auth/login {phone, password}
    A->>S: login(phone, password)
    S->>DB: 查 users by phone
    S->>S: bcrypt.compare（失败计数 + 5 次锁定 15min）
    S->>T: issueTokenPair(user)
    T->>T: access = JWT{sub, role, scope:'shop', tv, jti} TTL 2h
    T->>T: refresh = crypto.randomBytes(32).hex，存库 sha256 值 + familyId
    T->>DB: insert refresh_tokens
    S-->>C: { accessToken, refreshToken, expiresIn, user }
```

| 项 | 约定 |
| --- | --- |
| Access Token | TTL **2h**；载荷 `{ sub, role, scope: 'shop'\|'admin', tv (tokenVersion), jti }`；密钥按 scope 分离（C 端与后台不同 secret） |
| Refresh Token | TTL **7d**；随机 32 字节 → **只存 sha256 哈希**；携带 `familyId`（轮换家族） |
| 轮换 | 每次 refresh：校验旧 token 未吊销 → 吊销旧记录（`revoked_at`）→ 签发新记录并写 `replaced_by_id` |
| 重放检测 | 用**已吊销**的 refresh token 再次刷新 → 判定为重放 → **吊销整个 familyId**（错误码 10008） |
| 登出 | 吊销当前 familyId 下所有未吊销记录；同时 `users.token_version++`（使已签发 access token 立即失效） |
| 强制下线 | 后台禁用用户 → `token_version++` → 该用户所有 access token 失效 |
| 传输 | 生产强制 HTTPS；Access Token 放请求头 `Authorization: Bearer <token>`；Refresh Token 走 httpOnly + Secure + SameSite=Lax Cookie（`/api/auth/refresh` 专用） |
| 后台隔离 | `adminOnly` 中间件校验 `scope === 'admin'`，C 端 token 打后台接口 → 403（ADMIN-01） |

### 7.2 授权（RBAC）

> **[v2 变更]** 本节 **全量重写**。v1 方案为「枚举角色 + 代码内权限点常量」，客户变更②要求**一期即实现动态角色管理台**，故改为**数据库驱动的动态 RBAC**。表设计见 `03-database.md` §3.10（`roles` / `permissions` / `role_permissions` / `admin_user_roles` 四表），权限点全清单见该节表格（约 50 个）。

**模型**：管理员 ⇄ 角色（多对多）⇄ 权限点（多对多）。C 端买家 **不进入** RBAC 体系，仍用 `users` 上的行级隔离（见本节末）。

| 层 | 载体 | 说明 |
| --- | --- | --- |
| 主体 | `admin_users` | **移除 v1 的 `role` 枚举列**；角色改由 `admin_user_roles` 关联 |
| 角色 | `roles` | 可在管理台增删改；`is_builtin=true` 的内置角色不可删除；`data_scope` ∈ `ALL`/`SELF` 两档 |
| 权限点 | `permissions` | 编码规范 **`资源:操作`**（特殊场景三段式如 `order:refund:audit`）；`module` 用于前端权限树分组；`is_sensitive` 标记敏感权限 |
| 绑定 | `role_permissions` / `admin_user_roles` | 均为多对多，各有唯一索引防重复分配 |

**权限点编码规范**

- 格式：`<资源>:<操作>`，资源用小写单数（`product` / `order` / `refund` / `coupon` / `promo` / `balance` / `fund` / `rbac:role` / `pay:channel` / `log`），操作取自固定枚举 `list` / `detail` / `create` / `update` / `delete` / `export` / `audit` / `adjust` / `publish` / `toggle`。
- **禁止**在代码里硬编码角色名做判断（`if (role === 'ADMIN')` 一律禁止），只允许判断权限点编码。这是 v1 → v2 最容易残留的坏味道，Code Review 必查。

**中间件改造**

```ts
// middlewares/authorize.ts（[v2 改造]，替换 v1 的 rbac.ts）
// 用法：authorize('order:ship')，多个为「与」关系；authorize.any('a','b') 为「或」
router.post('/orders/:no/ship',   authorize('order:ship'),         AdminOrderController.ship);
router.post('/refunds/:no/audit', authorize('order:refund:audit'), AdminRefundController.audit);
router.post('/balance/adjust',    authorize('balance:adjust'),     AdminBalanceController.adjust);
```

解析顺序：`jwtAuth` 解出 `adminUserId` → `authorize` 取该管理员的权限点集合 → 判定 → 不通过抛 `AuthError(10010, '无此操作权限')`（**不返回缺哪个权限点**，避免探测后台能力面）。

**权限缓存与失效**

| 项 | 策略 |
| --- | --- |
| 缓存 key | `rbac:perms:{adminUserId}` → `Set<permissionCode>`，TTL **60s** |
| 敏感权限 | `permissions.is_sensitive = true` 的权限点（`refund:audit` / `balance:adjust` / `fund:reconcile` / `rbac:*` / `pay:channel:*`）**绕过缓存，每次实时查库判定** —— 资金与权限自身的操作不接受 60s 的过期窗口 |
| 主动失效 | 角色权限变更、管理员角色调整、角色停用/删除 → 立即 `DEL` 受影响管理员的 key（角色变更时按 `admin_user_roles` 反查全部受影响管理员）。**权限变更实时生效**是客户明确要求 |
| 兜底 | Redis 不可用时**降级为直查数据库**（不降级为放行）。见 §5.9 Redis 使用边界：权限判定的权威源永远是数据库 |

**内置超级管理员**

`SUPER_ADMIN`（`roles.is_builtin=true`）在 `authorize` 中**短路放行全部权限点**，且：不可删除该角色、不可编辑其权限、不可解绑最后一个持有该角色的管理员（防把自己锁在门外）、其操作全部写 `operation_logs`。

**数据权限（`roles.data_scope`）**

一期两档：`ALL`（可见全部数据）/ `SELF`（仅可见自己创建或负责的数据）。在 Repository 层按 `data_scope` 注入 `where` 条件，Service 层不允许绕过。二期如需部门/门店维度再扩枚举，接口不变。

**升级迁移（v1 → v2）**

原 `admin_users.role` 枚举列的数据需迁移：`SUPER_ADMIN` → 绑定内置超管角色，`ADMIN` → 绑定内置「运营管理员」角色，随后删除该列。迁移脚本与回滚方案见 `03-database.md` §3.10。

**数据行级权限**：C 端所有查询强制带 `where: { userId }`（由 Repository 层强制注入，Service 层不允许绕过）；越权返回 `AuthError(10009)` 而非 `NotFound`（避免信息泄露可改为 404，本项目按 PRD 要求返回 403）。

### 7.3 参数校验

| 项 | 约定 |
| --- | --- |
| 位置 | `src/validators/*.schema.ts` 集中管理，路由层声明式挂载 |
| 校验目标 | `params` / `query` / `body` 全覆盖；未知字段 `strict()` 拒绝 |
| 金额入参 | `z.number().int().nonnegative()`（单位分），禁止接收小数元 |
| 手机号 | `/^1[3-9]\d{9}$/` |
| 分页 | `page ≥ 1`、`1 ≤ pageSize ≤ 100` |
| 失败响应 | `ValidationError(90001)` + `data.errors[]`（字段级） |
| 富文本 | 商品详情 HTML 必须过 `utils/sanitize.ts` 白名单（允许 `p/br/strong/em/ul/ol/li/img[src|alt]/h2-h4/a[href]`），过滤 `script/iframe/on*事件/javascript:协议` |

### 7.4 注入与 XSS 防护

| 威胁 | 防护 |
| --- | --- |
| SQL 注入 | ① 全量使用 Prisma 参数化查询；② **禁止字符串拼接 SQL**；③ 必须使用原生 SQL 时（库存 CAS、批量扫描），**一律用 Prisma 的模板标签占位符** `Prisma.sql`/`$queryRaw\`...\``，禁止 `$queryRawUnsafe`；④ 动态 `ORDER BY` 只允许白名单枚举（不接受前端传入原始排序字段） |
| XSS（输入） | 富文本白名单清洗（见 7.3）；普通文本字段存原值，输出时转义 |
| XSS（输出） | Express 统一 `Content-Type: application/json; charset=utf-8`；前端**禁止**用 `v-html` 渲染用户输入，仅商品详情（已清洗）例外 |
| XSS（响应头） | `helmet` CSP：`default-src 'self'; img-src 'self' data: https:; script-src 'self'; object-src 'none'` |
| CSRF | 采用 Bearer Token（非 Cookie 自动携带）+ `SameSite=Lax`，天然免疫；refresh token Cookie 限定路径 |
| 点击劫持 | `X-Frame-Options: DENY`、`frame-ancestors 'none'` |
| 嗅探 | `X-Content-Type-Options: nosniff` |
| 参数污染 | `hpp` 中间件 |

### 7.5 密码存储与敏感数据

| 项 | 约定 |
| --- | --- |
| 哈希算法 | bcrypt，cost = **12**；因 bcrypt 截断 72 字节，先 `sha256(password)` 再 bcrypt |
| 传输 | 生产 HTTPS；P1 可加前端 `sha256(密码 + 服务端下发盐)` 后传输（SEC-11） |
| 强度 | ≥ 8 位，含字母与数字（前端 + 后端双重校验） |
| 敏感字段脱敏 | `utils/mask.ts`：手机号 `138****8888`、姓名 `张**`、地址详情页完整/列表页截断 |
| 密钥管理 | 全部走环境变量，不入代码库；生产建议接入 KMS/配置中心 |

### 7.6 其他安全项

| 项 | 约定 |
| --- | --- |
| 请求体大小 | 全局 `1mb`，上传路由单独放宽 |
| 上传安全 | 见 5.6；**文件不存可执行权限**，访问走静态目录（Nginx 禁用脚本执行） |
| 订单号/单号 | 含时间 + 随机段，不可枚举（禁止纯自增暴露） |
| 后台二次确认 | 手工调账、批量上下架、批量删除、取消已支付订单 → 前端强制二次确认 + 后端校验 `confirmToken`（P1，错误码 70003） |
| 错误信息安全 | 生产环境 `message` 不暴露堆栈与 SQL；`data` 不含内部 ID 结构细节 |
| 依赖安全 | CI 集成 `npm audit`（高危阻断） |

---

## 8. 积分体系预留（第二阶段，**本期不实现**）

> 本节仅说明「架构上留了哪些口子」，**一期不建表、不写接口、不做 UI**。工程师在一期只需保证以下几点不写死。

| 预留点 | 位置 | 一期状态 |
| --- | --- | --- |
| 订单金额计算链路的积分抵扣项 | `orders.point_deduct_amount` 字段 + `PriceService` 的扣减项 | **建字段，恒为 0**；`AmountSummary.vue` 展示「积分抵扣 ¥0.00（二阶段）」占位行 |
| 订单完成事件钩子 | `core/eventBus.ts` 的 `order.completed` 事件 | **建事件总线，注册空监听器**；一期确认收货时 `emit('order.completed')`，无副作用 |
| 与资金流水同构的积分流水骨架 | `fund_transactions` 的 `account_type` 枚举已含 `POINT` 扩展位 | 一期只产生 `PLATFORM_CASH`；二期按同结构建 `point_transactions`（流水号/幂等号/业务类型/关联单号/分值/方向/时间/操作人）或复用同表按 `account_type` 分流 |
| 用户积分账户 | 二期建 `point_accounts`（用户维度：总积分/可用/冻结） | 一期**不建表** |
| 配置开关 | `SHOP__POINT__ENABLED` | 一期恒 `false`，所有积分分支被短路 |
| 积分有效期与退回 | 二期定时任务 `expirePoints.job.ts` + 退款时按比例退回 | 一期不涉及 |
| 金额分摊链路 | `PriceService` 的扣减项顺序：商品金额 → 优惠 → **积分抵扣** → 运费 | 一期积分抵扣恒 0，分摊算法已支持任意扣减项数量 |

**一期必须避免的反模式**：① 把金额恒等式写死为「商品金额 - 优惠 + 运费」而漏掉积分项；② 确认收货逻辑里直接写业务而没有事件钩子；③ `fund_transactions.account_type` 直接写死字符串而不走枚举。

---

## 9. 假设与待确认

| # | 假设 | 若不成立的应对 |
| --- | --- | --- |
| A1 | 一期单商户自营（PRD Q9=A），资金账户只有 1 个平台账户 | 多商户需引入 `merchant_id` + 分账流水，改动较大，需重新设计 |
| A2 | ~~一期不做优惠券/促销（PRD Q12=A），`discount_amount` 恒 0~~ → **[v2 已推翻]** 客户变更①要求一期实现优惠券/促销 | 已落实：`PriceService` 含优惠分摊与按行退回，见 §0 落点表① |
| A3 | 售后期 7 天（PRD Q6=A），售后退款接口 P1 | — |
| A4 | 商品上下架无审核流（PRD Q8=A），`products.status` 保留 `DRAFT` 但一期不用 | — |
| A5 | 一期不做多规格图片（PRD Q7=A） | — |
| A6 | 部署形态单机，架构按多实例预留（PRD Q15=B 预留） | 多实例时确认 Redis 为独立实例且已持久化（BullMQ 依赖） |
| A7 | 短信验证码登录为 P1（PRD Q11=A），一期仅手机号 + 密码 | — |
| A8 | ~~后台 RBAC 一期用枚举（见 7.2）~~ → **[v2 已推翻]** 客户变更②要求一期实现动态角色管理台 | 已落实：§7.2 全量重写为动态 RBAC，四表设计见 `03-database.md` §3.10 |
| A9 | ~~支付回调采用**同步事务处理**~~ → **[v2 已推翻]** 客户变更③接入微信支付，其强制 5s 内应答 | 已落实：回调改为「验签 + 落库 + 投递队列 + 立即应答」，异步 Worker 消费，见 §10 |
| A10 | **[v2 新增]** 银行卡走聚合支付服务商（非直连银联），一期先 mock 保留切换位 | 若客户已有银联进件资质则直接走直连，仅替换 §6.5.6 配置项，其余设计不变 |
| A11 | **[v2 新增]** 一笔订单只用一种支付方式（v1.1 客户更正，取消混合支付） | 若二期恢复混合支付，需引入支付单父子结构 + 退款分配模式，改动较大 |

---

## 10. [v2 新增] 异步队列设计（BullMQ）

> **为什么现在必须引入**：v1 的 A9 假设「回调同步处理」成立的前提是只有 mock 和支付宝。客户变更③接入**微信支付后该假设作废** —— 微信 APIv3 要求商户在 **5 秒内**返回应答，否则判定失败并进入重试队列（最多 15 次），而我们的入账事务涉及订单 + 库存 + 资金流水 + 负债结转多表写入，在库压力下无法保证 5s 内完成。**一次超时就会引发渠道重复回调，而重复回调 + 未完成的事务是资金重复入账的高危组合。**

### 10.1 队列清单

| 队列名 | 生产者 | 消费者职责 | 并发 | 重试 |
| --- | --- | --- | --- | --- |
| `payment-callback` | 各渠道回调接口 | 执行支付成功入账事务（订单状态、库存 frozen→sold、资金流水、负债结转） | 5 | 5 次，指数退避 2s/8s/32s/2m/8m |
| `refund-exec` | 退款审核通过 | 调用渠道退款 API + 回写退款单（**渠道调用在事务外**） | 3 | 5 次，指数退避 |
| `order-close` | 下单时注册 delayed job（30min） | 超时关单 + 释放冻结库存 + 解冻优惠券 | 3 | 3 次 |
| `order-auto-confirm` | 发货时注册 delayed job（15 天） | 自动确认收货 | 2 | 3 次 |
| `notify` | 各业务节点 | 短信/客服通知（失败不影响主流程） | 10 | 3 次，失败仅告警 |

### 10.2 回调链路（关键路径）

```
渠道 POST 回调
  ↓  ① 验签（失败立即 400，不入队）
  ↓  ② 落 integration_call_logs（原始报文，敏感字段脱敏）
  ↓  ③ 投递 payment-callback 队列（jobId = 渠道交易号，天然去重）
  ↓  ④ 立即返回渠道成功应答（目标 < 200ms）
      ─────────── 以上同步，以下异步 ───────────
Worker 消费
  ↓  ⑤ 幂等三重保险：jobId 去重 → idempotency_records 抢占 → 支付单状态机校验
  ↓  ⑥ 开事务：订单状态 / 库存 frozen→sold / fund_transactions / order_status_logs
  ↓  ⑦ 提交 → 事务外触发通知
```

**设计要点**

| 项 | 做法 |
| --- | --- |
| jobId 去重 | `jobId = ${channel}:${channelTxNo}`，BullMQ 对相同 jobId 天然去重，**这是第一道防线**，但**不可作为唯一防线**（job 完成后被清理，晚到的重复回调会重新入队） |
| 幂等权威源 | 仍是数据库：`idempotency_records`（scope=`PAY:{orderNo}`）+ 支付单状态机 + `fund_transactions` 唯一索引。**Redis/队列只做削峰去重，不作为幂等权威**（呼应 §5.9 Redis 使用边界） |
| 事务内禁止外部调用 | Worker 里**先本地事务提交，再调渠道/通知**。渠道 `closePayment`、短信一律事务外 |
| 死信处理 | 超过最大重试进 `failed` 状态并**告警 + 落 `integration_call_logs`**，提供后台「异常回调重放」入口（需 `fund:reconcile` 权限），人工核对后重放 |
| 多实例防重 | BullMQ 基于 Redis，同一 job 只会被一个 Worker 消费，天然满足多实例。delayed job 亦然 |
| 兜底扫描 | `node-cron` 每分钟扫描「超时未关单」「支付中超过 10 分钟但渠道已成功」的订单，防 job 丢失（Redis 重启且未持久化的场景）。**兜底逻辑必须与 Worker 共用同一个幂等函数**，不允许各写一套 |
| requestId 透传 | job data 携带 `requestId`，Worker 消费时重建 `AsyncLocalStorage` 上下文，保证日志可串联（见 §5.3） |
| 部署要求 | Worker 与 API 进程**分离启动**（`npm run start:worker`），避免长任务拖慢 API 响应；单机部署时同机双进程即可 |

### 10.3 mock 与支付宝是否也走异步

**统一走异步**。理由：若 mock/支付宝同步、微信异步，则支付入账存在两条代码路径，幂等与回滚逻辑要维护两遍 —— 这是资金系统里最不该有的分支。统一异步后 mock 只是"立即触发回调"的假渠道，链路与真实渠道完全一致，**联调即测试**。

代价是 mock 支付后前端需轮询/等待 1~2 次订单状态查询才能看到已支付，这在体验上完全可接受（真实渠道本来也是异步）。

---

## 11. [v2 新增] 优惠计算引擎（`PriceService` + `PromotionEngine`）

> 客户变更①要求一期实现优惠券/促销。优惠一旦引入，**金额链路就从「一步减法」变成「多阶段管道」**，必须有独立引擎承载，否则规则会散落在下单、结算预览、退款三处并逐渐不一致。

### 11.1 计算管道（顺序不可调换）

```
① 商品原价小计     goods_amount = Σ(服务端重算的 price × qty)
        ↓
② 促销活动优惠     promo_discount   ← PromotionEngine（自动生效，无需用户选择）
        ↓
③ 优惠券优惠       coupon_discount  ← CouponEngine（用户选择，门槛基于「促销后」金额判定）
        ↓
④ 优惠分摊到行     Σ(items.discount_amount) = promo_discount + coupon_discount  【断言 E3】
        ↓
⑤ 运费计算         freight_amount（满 99 包邮，否则 12 元；判定基数 = 促销与券优惠后的商品金额）
        ↓
⑥ 恒等式全量校验   E1 ~ E7 逐条 assert，任一失败抛错
        ↓
   AmountSummary（返回给结算页 / 传入下单事务）
```

**关键顺序决策**

| 决策点 | 结论 | 理由 |
| --- | --- | --- |
| 促销与券的先后 | **先促销、后券** | 促销是商品维度自动生效的「改价」，券是订单维度的「再减」。反过来会让券门槛基于虚高的原价判定，用户体验上是"套路" |
| 券门槛判定基数 | **促销后商品金额**（不含运费） | 与 `05-PRD-变更.md` Q-B14 一致 |
| 包邮判定基数 | **所有优惠后的商品金额** | 保守口径，避免"用券后不满 99 却仍包邮"造成运费漏收 |
| 优惠是否作用于运费 | **不作用**（E5） | 一期不做运费券，简化退款分摊 |

### 11.2 引擎接口

```ts
// services/price/PriceService.ts
interface PriceInput {
  userId: bigint;
  items: { skuId: bigint; quantity: number }[];   // 只信 skuId 与数量，价格一律服务端查
  couponId?: bigint;                              // 用户选择的券（一期一单一券）
  addressId?: bigint;                             // 运费可能依赖地区（一期不依赖，预留）
}

interface AmountSummary {
  goodsAmount:    number;   // 分
  promoDiscount:  number;
  couponDiscount: number;
  discountAmount: number;   // = promo + coupon
  freightAmount:  number;
  payAmount:      number;   // 应付总额
  items: {                  // 行级分摊结果，直接落 order_items
    skuId: bigint; price: number; quantity: number;
    discountAmount: number;  // 该行分摊到的优惠
    actualAmount:   number;  // price*qty - discountAmount
    promotionId?: bigint;    // 命中的活动（可追溯）
  }[];
  appliedPromotions: { promotionId: bigint; ruleId: bigint; discount: number }[];
  appliedCoupon?:    { couponId: bigint; templateNo: string; discount: number };
}

// 同一个方法同时服务「结算预览」与「下单」，保证两处金额绝对一致
calculate(input: PriceInput, opts?: { forOrder?: boolean }): Promise<AmountSummary>;
```

**强制约定**：结算页预览与下单**必须调用同一个 `calculate`**。不允许前端传金额、不允许下单时走另一套简化逻辑 —— 这是价格篡改与"预览价与实付价不一致"投诉的唯一来源。

### 11.3 一期支持的规则类型

| 类型 | 规则参数 | 叠加 |
| --- | --- | --- |
| 满减活动 | 门槛金额 + 减免金额 | 同商品同时段仅命中**优惠力度最大**的一个活动（不叠加） |
| 满折活动 | 门槛金额 + 折扣率（万分比） | 同上 |
| 限时折扣 | 时间区间 + 折扣率 | 同上 |
| 满减券 | 门槛 + 面额 | 一单一券，与活动**可叠加** |
| 折扣券 | 门槛 + 折扣率 | 同上 |
| 无门槛券 | 面额（门槛强制 0） | 同上 |

> 活动互斥而券可与活动叠加，是一期的明确口径。若二期要做券叠加，需引入优先级与互斥组配置，`PromotionEngine` 已按「规则列表 → 命中筛选 → 择优/叠加」三段式实现，扩展时不动调用方。

### 11.4 与下单事务的边界

| 阶段 | 在事务内？ | 说明 |
| --- | --- | --- |
| `calculate` 价格计算 | ❌ 事务外 | 纯读 + 计算，耗时不确定，不占事务 |
| 券冻结（`AVAILABLE → FROZEN`） | ✅ **事务内** | 条件更新 `WHERE status='AVAILABLE'`，`affectedRows=0` 即抛「券已被占用」（12007），防同一券并发下单 |
| 活动库存/限量扣减 | ✅ **事务内** | 同券逻辑，条件更新 |
| 写 `order_coupon_records` | ✅ **事务内** | 记录本单用券快照（含分摊结果），供退款时按行退优惠 |
| 券核销（`FROZEN → USED`） | ✅ **支付成功事务内** | 下单只冻结不核销；支付成功才核销 |
| 券解冻（`FROZEN → AVAILABLE`） | ✅ **取消/超时关单事务内** | 与库存释放同事务；已过期的券解冻后置 `EXPIRED` 而非 `AVAILABLE` |

**并发要点**：多 SKU 场景下「券冻结 + 库存 CAS」的加锁顺序固定为 **先券后库存**（券只有一条记录，先拿掉冲突面最小的），库存内部再按 `sku_id` 升序，避免与其他事务交叉死锁。
