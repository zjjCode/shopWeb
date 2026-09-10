-- ============================================================================
-- 001_add_check_constraints.sql
-- 手工迁移补充：Prisma 不支持、需手工迁移的约束
-- 来源：docs/03-database.md §2.1
-- 创建：2026-09-04（T005）
--
-- ⚠️ 执行前提：
--   1. 已通过 `prisma migrate dev` / `prisma migrate deploy` 建好全部 38 张表
--   2. MySQL >= 8.0.16（8.0.16 之前的版本会解析但不强制执行 CHECK 约束）
--   3. 本文件**幂等性有限**：重复执行会因「约束已存在」报错，
--      已执行过的语句需先 DROP CONSTRAINT 再重跑
--
-- ⚠️ 尚未执行：当前环境无 MySQL 实例（见 log-007）。待数据库就绪后执行：
--      mysql -h <host> -u <user> -p <db> < prisma/sql/001_add_check_constraints.sql
--
-- CHECK 约束的定位：超卖与账目不平的**最后一道兜底**。
-- 业务层 CAS 已做拦截，约束只用于捕获逻辑漏洞并触发告警，不承担主校验职责。
-- ============================================================================

-- ============================================================================
-- 一、v1 基础约束（001_add_check_constraints.sql 原始内容）
-- ============================================================================

-- 库存三段口径非负
ALTER TABLE `sku_stocks`
  ADD CONSTRAINT `chk_stock_non_negative`
  CHECK (`available` >= 0 AND `frozen` >= 0 AND `sold` >= 0 AND `total` >= 0);

-- 库存恒等式：总量 = 可用 + 冻结 + 已售（由巡检任务对账校验）
ALTER TABLE `sku_stocks`
  ADD CONSTRAINT `chk_stock_identity`
  CHECK (`total` = `available` + `frozen` + `sold`);

-- 订单金额恒等式
-- [v2 变更] 恒等式改写为四级扣减（05-PRD-变更 §2.3.8），
-- 原 discount_amount 单字段已拆为三级：row_promo / order_promo / coupon
ALTER TABLE `orders`
  ADD CONSTRAINT `chk_order_amount_identity`
  CHECK (`pay_amount` = `goods_amount` - `row_promo_discount` - `order_promo_discount`
                        - `coupon_discount` - `point_deduct_amount` + `freight_amount`);

-- 订单金额非负 + 已退金额不超过实付
ALTER TABLE `orders`
  ADD CONSTRAINT `chk_order_amount_non_negative`
  CHECK (`goods_amount` >= 0 AND `pay_amount` >= 0 AND `refunded_amount` >= 0 AND `pay_amount` >= `refunded_amount`);

-- 资金流水金额恒正、余额快照非负
ALTER TABLE `fund_transactions`
  ADD CONSTRAINT `chk_fund_amount_positive`
  CHECK (`amount` > 0 AND `before_balance` >= 0 AND `after_balance` >= 0);

-- 订单行数量与金额自洽
ALTER TABLE `order_items`
  ADD CONSTRAINT `chk_order_item_positive`
  CHECK (`quantity` > 0 AND `unit_price` >= 0 AND `goods_amount` = `unit_price` * `quantity`);

-- ============================================================================
-- 二、[v2 新增] 约束（docs/03-database.md §2.1 的 003_add_v2_constraints.sql 段）
-- 说明：设计文档把 v2 约束编号为 003，本次按 team-lead 要求合并进 001，
--       以便「一次执行补齐全部 CHECK 约束」，避免多文件执行顺序踩坑。
-- ============================================================================

-- ① 资金账户：永不透支（防透支的最后一道兜底，BAL-05「硬校验，不可配」）
ALTER TABLE `fund_accounts`
  ADD CONSTRAINT `chk_account_balance_non_negative`
  CHECK (`balance` >= 0 AND `frozen_balance` >= 0 AND `total_in` >= 0 AND `total_out` >= 0);

-- ② 用户余额账户：可用余额 = 余额 - 冻结，不得为负
ALTER TABLE `fund_accounts`
  ADD CONSTRAINT `chk_account_available_non_negative`
  CHECK (`balance` >= `frozen_balance`);

-- ③ 平台账户唯一性：一期只允许 1 条 PLATFORM_CASH
--    （用 generated column 绕开 MySQL 不支持部分唯一索引的限制）
--    ⚠️ 执行后需把该列加入 prisma/schema.prisma 并标 @ignore，
--       否则 `prisma migrate dev` 会试图删掉它
ALTER TABLE `fund_accounts`
  ADD COLUMN `platform_unique_key` VARCHAR(16)
    GENERATED ALWAYS AS (IF(`account_type` = 'PLATFORM_CASH', 'PLATFORM_CASH', NULL)) VIRTUAL,
  ADD UNIQUE KEY `uk_platform_cash` (`platform_unique_key`);

-- ④ 订单行：行实付守恒 —— 行实付 = 行金额 - 行促销优惠 - 行分摊优惠
--    （分摊守恒由业务层 + 对账任务保证，行内守恒可下推到 DB）
ALTER TABLE `order_items`
  ADD CONSTRAINT `chk_order_item_payable`
  CHECK (`payable_amount` = `goods_amount` - `promo_discount` - `allocated_discount`);

ALTER TABLE `order_items`
  ADD CONSTRAINT `chk_order_item_discount_bound`
  CHECK (`promo_discount` >= 0 AND `allocated_discount` >= 0
         AND `promo_discount` + `allocated_discount` <= `goods_amount`
         AND `refunded_amount` <= `payable_amount`
         AND `refunded_quantity` <= `quantity`);

-- ⑤ 券模板：类型与字段的组合合法性（CPN-02）
ALTER TABLE `coupon_templates`
  ADD CONSTRAINT `chk_coupon_type_fields`
  CHECK (
    (`type` = 'FULL_REDUCE'   AND `threshold_amount` > 0 AND `discount_amount` > 0 AND `discount_rate` IS NULL)
 OR (`type` = 'DISCOUNT'      AND `threshold_amount` >= 0 AND `discount_rate` > 0 AND `discount_rate` < 10000 AND `max_discount` > 0)
 OR (`type` = 'NO_THRESHOLD'  AND `threshold_amount` = 0 AND `discount_amount` > 0 AND `discount_rate` IS NULL)
  );

-- ⑥ 券模板：有效期策略与字段互斥（CPN-11）
ALTER TABLE `coupon_templates`
  ADD CONSTRAINT `chk_coupon_valid_type`
  CHECK (
    (`valid_type` = 'FIXED_RANGE' AND `valid_start` IS NOT NULL AND `valid_end` IS NOT NULL AND `valid_start` < `valid_end` AND `valid_days` IS NULL)
 OR (`valid_type` = 'AFTER_CLAIM' AND `valid_days` > 0 AND `valid_start` IS NULL AND `valid_end` IS NULL)
  );

-- ⑦ 券模板：发放量不超总量（配合 issued_count 的 CAS 更新，双保险）
ALTER TABLE `coupon_templates`
  ADD CONSTRAINT `chk_coupon_issued_bound`
  CHECK (`total_count` IS NULL OR `issued_count` <= `total_count`);

-- ⑧ 券实例：状态与关联字段的一致性（防止「USED 却没有订单号」这类脏数据）
ALTER TABLE `coupons`
  ADD CONSTRAINT `chk_coupon_status_fields`
  CHECK (
    (`status` = 'UNUSED'      AND `used_order_no` IS NULL AND `locked_order_no` IS NULL)
 OR (`status` = 'LOCKED'      AND `used_order_no` IS NULL AND `locked_order_no` IS NOT NULL)
 OR (`status` = 'USED'        AND `used_order_no` IS NOT NULL)
 OR (`status` IN ('EXPIRED','INVALIDATED'))
  );

-- ⑨ 充值单：单笔限额（BAL-03，默认 100 ~ 500000 分，可配）
ALTER TABLE `recharge_orders`
  ADD CONSTRAINT `chk_recharge_amount_range`
  CHECK (`amount` >= 100 AND `amount` <= 500000 AND `gift_amount` >= 0 AND `pay_amount` = `amount`);

-- ⑩ 支付方式：限额合法性
ALTER TABLE `payment_methods`
  ADD CONSTRAINT `chk_pay_method_limit`
  CHECK (`min_amount` >= 0 AND (`max_amount` = 0 OR `max_amount` >= `min_amount`)
         AND `fee_rate` >= 0 AND `fee_rate` <= 10000);

-- ⑪ 促销活动时间区间
ALTER TABLE `promotions`
  ADD CONSTRAINT `chk_promotion_time_range`
  CHECK (`start_at` < `end_at`);

-- ⑫ 负债结转对：只有 PLATFORM_CASH 账户可以写 LIABILITY_SETTLE_* ，且必须带 tx_group_no
--    （USER_BALANCE 账户的流水 is_liability 恒 false，见 §3.6.4）
--    这是「负债结转对」正确性的数据库级护栏：
--      ① 结转流水只可能记在平台账户
--      ② 结转流水必带 tx_group_no（否则对账无法配对）
--      ③ LIABILITY_SETTLE_IN 的 is_liability 必为 false、LIABILITY_SETTLE_OUT 必为 true
--    三者任一被写反，事务直接失败，不会污染账目。
ALTER TABLE `fund_transactions`
  ADD CONSTRAINT `chk_liability_settle_pair`
  CHECK (
    (`biz_type` NOT IN ('LIABILITY_SETTLE_IN','LIABILITY_SETTLE_OUT'))
 OR (`account_type` = 'PLATFORM_CASH' AND `tx_group_no` IS NOT NULL
     AND `is_liability` = (`biz_type` = 'LIABILITY_SETTLE_OUT'))
  );

-- ============================================================================
-- 附：002_add_fulltext_index.sql（可选，商品搜索 P1，未纳入本次执行）
--   ALTER TABLE `products` ADD FULLTEXT INDEX `ft_products_name` (`name`, `sub_title`);
-- ============================================================================
