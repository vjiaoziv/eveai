# 07 资产镜像 owner/lane 隔离

## 1. 修复前风险

资产镜像旧路径按 `character_id` 删除后重建。若同一角色在 chat A 和 chat B 分别工作，后运行的 lane 会删除前一个 lane 的镜像；所有权转移后新 owner 也可能覆盖旧 owner 的 evidence。

## 2. 修复后的主键

`character_assets` 使用：

```text
(character_id, owner_user_id, owner_chat_id, binding_epoch, item_id)
```

- 同一角色可以有多个 owner/lane/epoch 行集；
- 同 lane/epoch 内的 item_id 仍唯一；
- 插入、更新、删除、计数和完整性检查都带 lineage predicate；
- `binding_digest` 只作写入时证据，不参与普通读取边界。

## 3. 同步生命周期

资产同步通过 `RealAssetSyncService` 协调器完成：

1. 捕获目标角色和 lineage；
2. 获取 lane-aware lease/job；
3. 校验所有分页和完整数据集；
4. 计算 canonical item-set hash；
5. 在 `BEGIN IMMEDIATE` 中校验 lease、generation、binding；
6. 原子替换当前 lineage 的 mirror；
7. 提交 completed snapshot 并把旧 generation 标记为非 latest；
8. 身份失配或旧 generation 写入时回滚/拒绝。

## 4. Job 和 snapshot 隔离

- 资产 job 记录 owner/chat/epoch、account owner hash 和 generation；
- lease 由同一 lineage 获取和续租；
- 旧进程的迟到响应不能覆盖新 generation；
- snapshot、valuation、change、tag 和 opportunity 查询都带 lane lineage；
- 历史 snapshot 保留，不因新 latest 出现而删除；
- 快照详情按固定 snapshot_id 和 lineage 鉴权。

## 5. 并发和不完整响应

- 分页未完成时不提交镜像；
- 关键资产字段非法时整批失败；
- 聚合数量溢出使用 safety check，拒绝提交；
- stale RUNNING job 可被回收，但旧 lease owner 不能继续提交；
- 旧 generation response 被 fencing 拒绝。

## 6. 测试证据

- `tests/audit/p9-3.3.8/asset-snapshot-pagination.test.ts`
- `tests/unit/p9-3.3.2-asset-integrity.test.ts`
- `tests/unit/p9-3.3.2-wallet-cross-connection-lease.test.ts`
- `tests/unit/p9-3.3.3-asset-race.test.ts`
- `tests/unit/p9-3.3.4-asset-fencing.test.ts`
- `tests/unit/p9-3.3.4-asset-unbind-race.test.ts`
- `tests/unit/p9-3.3.5-asset-race.test.ts`
- `tests/unit/p9-3.3.6-asset-writer-unification.test.ts`
- 5 轮并发重复日志：`logs/19-concurrency-repeat-5x.log`

## 7. 限制

以上是隔离 SQLite 和多进程测试。未在真实 ESI 资产分页、真实跨主机进程暂停、真实文件锁竞争和真实角色重绑下验证。`character_assets` 仍是通用镜像，不代表真实资产快照历史；历史由 `real_asset_snapshots` 保留。
