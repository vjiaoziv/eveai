# 20 缺陷与修复优先级

## 1. 统计

| 等级 | 数量 | 编号 |
|---|---:|---|
| P0 | 0 | - |
| P1 | 1 | F-P9339-01 |
| P2 | 1 | F-P9339-02 |
| P3 | 0 | - |

## 2. F-P9339-01（P1）：Scope 刷新破坏最新资产快照与 Mirror 可见性

### 现象

同一 owner/chat/epoch 下发生正常 scope 刷新后，binding digest 改变。第二次资产同步无法清除旧 latest，插入新 latest 时触发唯一约束，job 标为 `FAILED`；旧 latest 和 mirror 保留在旧 digest，在新 digest 下不可见。

### 证据

- 测试：`tests/audit/p9-3.3.9/asset-lineage-scope-refresh.test.ts:96`。
- 失败：`UNIQUE constraint failed: real_asset_snapshots.character_id, real_asset_snapshots.owner_user_id, real_asset_snapshots.owner_chat_id, real_asset_snapshots.binding_epoch`。
- 日志：`logs/40-asset-scope-refresh-repro.log`、`logs/60-p9339-full-suite.log`。
- 代码：
  - `src/assets/asset-lineage.ts:138-152`：digest 纳入 scopes。
  - `src/assets/asset-lineage.ts:190-207`：lineage predicate 纳入 digest。
  - `src/db/migrations.ts:1928-1931`：latest 唯一索引不纳入 digest。
  - `src/assets/asset-sync-service.ts:845-850`：旧 latest 按新 digest 查找。
  - `src/assets/asset-sync-service.ts:938-945`：仅找到 previous 时才清 old latest。
  - `src/assets/asset-sync-service.ts:1041-1043`：错误导致 job FAILED。

### 影响

- 正常 EVE scope 刷新后资产同步稳定失败。
- 最新快照与 mirror 在当前 lineage 下不可见。
- 可能造成资产页面 N/A、错误去重、机会判断缺失或使用过期资产上下文。
- 未观察到跨 owner 数据泄露，旧数据未被物理删除，故不升级为 P0。

### 修复优先级

`P9.3.3.10-A`，立即修复并作为阻断项。

### 验收建议

- 同一 owner/chat/epoch 增加、删除、重排 scopes 后，第二次同步成功。
- 任一时刻只有一个 `is_latest = 1`。
- 同步失败时 last-known-good 仍以明确状态可见，不静默消失。
- snapshot/mirror/changes/jobs 使用一致 lineage 语义。
- 覆盖失败回滚、重复刷新和两 lane 隔离。

## 3. F-P9339-02（P2）：Record-scoped 审计历史参数绑定错误

### 现象

调用 `P93AuditService.events(db, characterId, recordId, limit, lineage)` 时，已知存在 3 条审计事件，但返回 0 条。

### 证据

- 测试：`tests/audit/p9-3.3.9/ledger-child-authorization.test.ts:265`。
- 失败：`expected [] to have a length of 3 but got +0`。
- 代码：`src/trading/p9-3-audit-service.ts:29-39`。
- 根因：SQL 顺序为 character → ownership → record_id；参数顺序为 character → record_id → ownership。

### 影响

- 原 owner 的 record-scoped 审计链被隐藏。
- 影响核实、冲正、更正历史的可追溯性。
- 未观察到跨 owner 数据泄露或写入越权，故为 P2。

### 修复优先级

`P9.3.3.10-B`，与 P1 同一修复阶段完成。

### 验收建议

- 无 `recordId` 与有 `recordId` 两种调用均正确。
- 原 owner 可见全部匹配事件。
- 新 owner/第三方仍返回空或拒绝。
- SQL 条件与参数以同一结构同步构造，避免再次错位。

## 4. P9.3.3.10 定向修复任务书

必须：

1. 修复 digest、latest 唯一性、旧 latest 替换和查询语义。
2. 修复审计服务 SQL/参数顺序。
3. 保留 P9.2 RealAssetSyncService 原子快照和历史保留机制。
4. 不削弱 REAL/PAPER 隔离、人工确认、财务触发器或 ESI GET-only。
5. 新增针对 scope 变化和 record-scoped 审计的独立回归测试。
6. 重新运行本阶段 13 files / 48 tests、历史回归和全部质量门禁。
7. 构建新的独立审计阶段；不得以修复者自测代替下一轮审计。

## 5. 证据等级

- 代码验证：已完成。
- 隔离测试数据验证：已完成并稳定复现。
- 真实环境验证：无。
- 尚未验证：修复后的行为；本轮不实施修复。
