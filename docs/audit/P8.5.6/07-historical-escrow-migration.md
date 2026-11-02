# P8.5.6 历史担保金迁移

## 迁移策略

src/db/migrations.ts:15-36：

1. 新增 escrow_migration_status。
2. 对 legacy_pending 买单：
   - 从 escrow_lock journal 获取初始担保金。
   - 扣除 order_spend、fee_payment、escrow_release。
   - 得到 escrow_locked。
   - fee_reserved = escrow_locked - 未成交货值。
   - 标记 recovered。
3. 无 escrow_lock journal 的历史订单：
   - escrow_locked=0。
   - fee_reserved=0。
   - 标记 unrecoverable，不参与账户负债计算。
4. 重复运行不会重新迁移 recovered/unrecoverable 行。

## 测试

tests/unit/p8-5-6-escrow-migration.test.ts:7

恢复场景：

~~~text
recovered escrow_locked = 71,470
recovered fee_reserved = 1,470
unrecoverable row = 0 / 0 / unrecoverable
~~~

第二次运行结果完全一致。

结论：历史数据迁移完成；不能恢复的数据已隔离。
