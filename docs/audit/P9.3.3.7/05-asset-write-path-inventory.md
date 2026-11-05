# 05 资产写入路径与镜像归属清单

## 全仓库写入扫描

执行：

```text
grep -R -n -E 'INSERT ... character_assets|UPDATE character_assets|DELETE FROM character_assets|REPLACE INTO character_assets' src web/src
```

结果只有两处运行时写入：

- `src/assets/asset-sync-service.ts:697`：通过 `INSERT INTO character_assets` 写入 mirror。
- `src/assets/asset-sync-service.ts:857`：`DELETE FROM character_assets WHERE character_id = ?`。

因此 P9.3.3.6 的统一 writer 目标基本成立：没有发现第二个 generic 写入器。但统一 writer 不等于作用域正确。

## F-P9337-02 的作用域缺陷

- `character_assets` 主键是 `(character_id, item_id)`，见 `src/db/schema.ts:546-563`。
- 同一用户可在多个 chat lane 中链接同一角色。
- 第二个 chat 同步时，`DELETE ... WHERE character_id = ?` 会删除第一个 chat 的 mirror。
- 第一个 chat 的已完成快照和 items 仍保留，导致 mirror 与 snapshot lineage 不一致。

## 调用链

`RealAssetSyncService.syncCharacter(db, characterId, ctxB, ...)`
→ 取得 lineage B
→ 读取 ESI rows
→ 删除该 character 的全部 `character_assets`
→ 用 lineage B 重建 mirror
→ 创建 B 的快照
→ A 的 snapshot 仍存在但 A 的 mirror 已被移除。

## 证据

- `tests/audit/p9-3.3.7/asset-consistency-audit.test.ts` 的 F-P9337-02。
- `logs/p9337-expanded-audit.log`。
- 断言：A mirror 从 1 行变为 0 行，B mirror 为 1 行，而 A 的 completed snapshot 仍为 1。
- 证据等级：隔离 SQLite + 真实服务代码（B 级）。

## 结论

统一 writer 是正向控制，但当前 delete 没有带 lineage/chat 条件。必须让 mirror 的删除、插入、快照和 job 使用完全相同的 owner/chat/binding 作用域，或将 mirror 主键/唯一键扩展为 lineage 维度。

## 后续验证要求

- 同一角色多 chat 并发同步。
- 同一 chat 多角色切换。
- 解绑/重绑与在途同步交错。
- 真实生产 SQLite 写锁和迁移回滚。
