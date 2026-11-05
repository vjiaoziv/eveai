# 13 资产镜像原子替换与 Scope 刷新

## 1. 正常替换路径

运行时资产 mirror/snapshot 写入通过 `RealAssetSyncService.syncCharacter`，而不是旧的无协调器写路径。提交阶段在同一个 write transaction 中执行：

- 重新读取 current binding，确认 owner/chat/epoch/digest 未变。
- 检查 job generation 和 lease。
- 旧 latest snapshot 替换。
- mirror、changes、valuation 关联和 snapshot 写入。
- 以 `commit.immediate()` 提交。

`src/eve/character-sync.ts:157-170` 将该路径固定为 `RealAssetSyncService`，不保留第二条直接 mirror 写入路径。

## 2. 稳定性测试

测试：`tests/audit/p9-3.3.9/character-sync-adversarial.test.ts:113`。

- 完整验证整个 asset payload 后才允许替换。
- 任意关键字段不完整时保留上一份有效数据。
- 同步失败状态反映失败，不伪装成功。
- 结果通过。

测试：`tests/audit/p9-3.3.9/asset-mirror-and-pagination.test.ts`。

- 不同 chat lane 的 mirror 重复替换互不破坏。
- 5 轮替换通过。

## 3. 新缺陷 F-P9339-01（P1）

测试：`tests/audit/p9-3.3.9/asset-lineage-scope-refresh.test.ts:96`。

复现：

1. 建立 owner/chat/epoch 固定的资产 binding，第一次同步成功。
2. EVE SSO 正常刷新 scopes，只新增 `esi-wallet.read_character_wallet.v1`。
3. ownership、chat、epoch 均未变化，但 binding digest 因 scopes 变化而改变。
4. 第二次同步返回新资产 payload。
5. 同步失败：`UNIQUE constraint failed: real_asset_snapshots.character_id, real_asset_snapshots.owner_user_id, real_asset_snapshots.owner_chat_id, real_asset_snapshots.binding_epoch`。
6. 旧 snapshot 仍为 `is_latest = 1`，但仍挂在旧 digest，按当前 digest 不可见。
7. 旧 mirror 数据仍留在旧 digest，按当前 digest 查询为空。

### 根因链

- `src/assets/asset-lineage.ts:138-152`：digest 包含 stored scopes。
- `src/assets/asset-lineage.ts:190-207`：所有 lineage 查询和更新包含 digest。
- `src/db/migrations.ts:1928-1931`：latest 唯一索引只约束 `(character_id, owner_user_id, owner_chat_id, binding_epoch)`，不包含 digest。
- `src/assets/asset-sync-service.ts:845-850`：previous latest 使用包含 digest 的 predicate 查找。
- `src/assets/asset-sync-service.ts:938-945`：只有找到 previous 时才清除旧 latest。
- 新 digest 下 previous 找不到，因此旧 latest 未被清除；插入新 latest 时撞上唯一索引。
- `src/assets/asset-sync-service.ts:1041-1043`：错误被包装并重新抛出，job 标为 `FAILED`。

### 影响

- 正常的 scope 刷新会使后续资产同步失败。
- 最新快照和 mirror 在刷新后的 binding 下不可访问。
- 用户会看到 N/A/无数据，或在其他路径继续看到旧数据但缺少明确一致性标识。
- 旧数据未被物理删除，未发现跨 owner 泄露；因此定级 P1，而非 P0。

### 修复方向

P9.3.3.10 必须统一 digest 在身份、查询、唯一索引和 latest pointer 替换中的语义。可选方向：

1. latest pointer 的唯一身份忽略无害 scope digest，并在同一事务中原子替换旧 latest；或
2. 若 digest 必须参与记录身份，则在 lineage 刷新时迁移/归档旧 latest 和 mirror，并保证唯一索引与查询使用同一键。

必须覆盖：scope 增加、scope 减少、scope 重排、重复刷新、失败回滚和跨 lane 隔离。

## 4. 当前测试结果

- 安全期望测试：失败，稳定复现 P1。
- 记录当前破坏状态的反例：通过，证明 job 为 FAILED、旧 latest 继续挂旧 digest、当前 digest 下无可见 snapshot/mirror。

日志：

- `logs/40-asset-scope-refresh-repro.log`
- `logs/60-p9339-full-suite.log`

## 5. 证据等级

- 代码验证：已完成。
- 隔离测试数据验证：已完成。
- 真实环境验证：无。
- 尚未验证：真实 SSO scope 刷新序列、生产数据中的历史 digest 分布和生产迁移行为。
