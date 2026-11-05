# 快照、镜像与 latest 原子性

## 1. 协调器事务

`RealAssetSyncService` 在单个 `BEGIN IMMEDIATE` 事务内执行：

1. 校验 job/generation/lease/binding。
2. 读取旧 latest。
3. 计算 canonical hash。
4. 替换 `character_assets` 镜像。
5. 清除旧 latest。
6. 插入 immutable snapshot/items/changes。
7. 完成 job 并释放 lease。

代码：`src/assets/asset-sync-service.ts:591-781`。

## 2. 故障注入结果

- 在镜像 INSERT 失败：镜像和 latest 回滚到旧版本。
- 清除旧 latest 后失败：回滚。
- job COMPLETED 更新失败：回滚。
- SIGKILL 在实际镜像 DELETE 后：SQLite 回滚 DELETE，旧镜像和旧 latest 保留。

新增测试：

- `tests/unit/p9-3.3.5-audit-findings.test.ts:293-338`
- `tests/unit/p9-3.3.5-crash-after-mutation.test.ts:145-181`

## 3. latest 唯一性

`real_asset_snapshots(character_id) WHERE is_latest=1` 的部分唯一索引保证同一角色最多一个 latest。协调器在旧 latest 清除与新 latest 插入的同一事务内完成切换。

## 4. 全系统一致性失败

不能给出“镜像、快照和 latest 全局原子一致”的结论：

- **F-P9335-03**：generic `src/eve/character-sync.ts:156-220` 直接替换 `character_assets`，不写 snapshot/job/lease。实测协调器 latest 为数量 4，generic 写入后镜像为数量 9。
- **F-P9335-01**：`src/assets/asset-sync-service.ts:674-690` 在 data hash 相同时直接复用旧 snapshot 并标记 COMPLETED，不检查当前镜像是否仍存在；解绑/重绑清空 legacy mirror 后，重复同步得到 `deduped=true` 但镜像行数仍为 0。

因此：

- 协调器事务内部：原子性通过。
- 全系统资产镜像与 latest：不原子、可分叉。
- 当前审计状态仍为失败。

## 5. 证据等级

- 隔离 SQLite 触发器/崩溃注入：已验证。
- 生产 SQLite 文件系统、长时间负载、真实 ESI：未验证。
