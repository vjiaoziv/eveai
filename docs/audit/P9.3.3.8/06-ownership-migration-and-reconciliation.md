# 06 所有权迁移与对账

## 1. 迁移原则

P9.3.3.8 迁移只做结构修复，不猜测历史数据所有权：

- 为 REAL 账本、证据、费用、事件、FIFO、计算、钱包游标、失败队列和资产快照增加 owner/chat/epoch；
- 保留旧行的 ownerless 状态；
- 重建需要新唯一键/主键的表；
- 重建索引并恢复财务触发器；
- 迁移必须可重复执行而不丢行。

## 2. 主要结构变化

### 2.1 账本

旧 `UNIQUE(character_id, ledger_key)` 无法支持同一角色不同 owner/lane 的独立记录。迁移重建 `real_trade_records`，保留 `record_id` 主键和财务字段，增加 lineage 列。旧行仍为 NULL/NULL/0。

### 2.2 钱包状态

`real_esi_transaction_sync`、`real_esi_transaction_sync_leases` 和 `real_esi_transaction_failures` 的主键增加 lineage。旧游标不会被新 owner 继承。

### 2.3 资产镜像

`character_assets` 主键改为：

```text
(character_id, owner_user_id, owner_chat_id, binding_epoch, item_id)
```

镜像删除和 upsert 条件同步改为该 envelope，避免 chat lane 互相删除。

### 2.4 审计和 P9 控制面

计算运行、证据关联、reconciliation、settings、opportunity、plan、job 和审计事件增加 owner/chat/epoch 与索引。旧行不自动归给当前绑定者。

## 3. 完整性和原子性

迁移测试检查：

- `PRAGMA foreign_key_check` 为空；
- 旧账本、游标、租约和失败行仍存在；
- 旧行 owner 为 NULL/NULL/0；
- 新 owner/lane 可插入独立游标和记录；
- 财务触发器仍存在并实际阻止删除/原位修改；
- 第二次运行迁移后行数、约束和触发器不变。

## 4. 对账

`P93ReconciliationService.run()` 先查找当前 lineage 的已完成 FIFO 计算。若没有当前 owner 的计算，直接拒绝，不能使用其他 owner 的计算结果。

对账中的 snapshot、valuation、later verified trade、change、FIFO lot 和 duplicate source cases 均按 lineage 过滤。其他 owner 的新交易不会把当前 owner 的对账标记为 stale。

## 5. Legacy 数据

无法证明归属的历史行：

- 保留用于审计；
- 不参与新 owner 的正常读取；
- 不参与当前 owner 的 FIFO、对账或 AI 分析；
- 如需恢复，需要人工核对原始来源、时间和证据，再通过受控流程建立归属。

本阶段没有实现“legacy 数据人工认领 UI”，这是残余风险，不应通过自动迁移绕过。

## 6. 验证

- `tests/audit/p9-3.3.8/migration-and-trigger-integrity.test.ts`：3/3 通过。
- `tests/audit/p9-3.3.8/reconciliation-ownership.test.ts`：6/6 通过。
- 日志：`logs/18-specialized-final.log`。

## 7. 限制

未对生产数据库执行迁移；未在生产 SQLite 文件上验证锁、耗时、备份和回滚。以上结论仅适用于隔离 SQLite 迁移测试。
