# 14 迁移和数据库完整性

## 1. 迁移目标

迁移必须同时满足：

1. 已存在数据和财务字段不丢失；
2. legacy 数据不被错误重新归属；
3. 同角色不同 owner/chat/epoch 可独立存在；
4. 财务不可删除/不可覆盖触发器仍生效；
5. 重复执行迁移幂等；
6. `PRAGMA foreign_key_check` 无错误。

## 2. 迁移步骤摘要

- 给 REAL 及 P9 相关表增加 owner/chat/epoch/digest 列；
- 重建主键/唯一键不兼容的表；
- 保留旧行的 NULL/NULL/0 legacy 标记；
- 重建索引；
- 删除并重建受表重建影响的财务触发器；
- 运行外键和结构检查。

## 3. 测试验证

`tests/audit/p9-3.3.8/migration-and-trigger-integrity.test.ts` 3/3 通过：

### 用例 1：legacy 保留和触发器完整性

- 构造旧账本、游标、租约和失败队列；
- 执行迁移；
- 旧账本仍为 ownerless；
- 旧游标 7700 保留；
- 失败 key 保留；
- 新 PK 形状符合预期；
- 删除交易抛 `真实交易记录不得直接删除`；
- 原位修改 verified/active 事实抛 `非草稿交易事实不可原地覆盖`；
- 外键检查为空。

### 用例 2：新 owner/lane 可独立写入

- 两个 owner/chat 可以插入各自游标和同名 ledger key；
- legacy 记录不被分配给新 owner；
- 两个 lane 的游标可以不同。

### 用例 3：迁移幂等

- 迁移前后行数一致；
- 约束和触发器仍存在；
- 外键仍通过。

## 4. 与 P9.2 资产历史的关系

资产同步仍由 `RealAssetSyncService` 协调：

- 当前 mirror 是原子替换的当前视图；
- `real_asset_snapshots` 和历史 item/valuation 行保留；
- 旧 generation 不因新 latest 删除；
- P9.2 的 snapshot history 机制没有被绕开。

## 5. 未验证

- 未在生产数据库执行迁移；
- 未验证生产数据量下的迁移耗时和磁盘空间；
- 未验证应用升级期间旧进程与新 schema 的混合运行；
- 未验证备份恢复演练。

因此迁移结论限定为隔离 SQLite 测试。

## 6. 最终迁移原子性补证（2026-11-05）

`runMigrations()` 在 `src/db/migrations.ts:51-52` 使用单个 SQLite transaction 包裹全部迁移步骤；钱包游标、lease 和 failure 表的 lineage 重建位于 `src/db/migrations.ts:1653-1751`。

`tests/audit/p9-3.3.8/migration-and-trigger-integrity.test.ts:298-349` 在资产表重建开始后注入异常，验证：

- 迁移抛出真实注入错误；
- `real_esi_transaction_sync_p9338` 和 `character_assets_p9338` 均不存在；
- 旧游标仍为 `7700`；
- 旧资产 `item_id=9001, quantity=7` 仍保留；
- 旧主键形状未被部分改写。

验证分级：已通过代码验证；已通过隔离 SQLite 迁移失败回滚测试；未在生产数据库验证。
