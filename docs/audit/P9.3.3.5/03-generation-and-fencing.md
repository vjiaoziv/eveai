# generation、lease 与 fencing

## 1. 协调器 fencing 链

`RealAssetSyncService` 维护：

- `jobId`
- `characterId`
- `generation`
- `lease(character_id, generation, job_id)`
- `binding_epoch`
- `binding_digest`
- `account_owner_hash`

最终提交事务重新验证：

- job 状态、generation、owner user/chat；
- binding epoch/digest 与 account owner hash；
- lease 的 generation/jobId；
- 当前绑定快照仍与原绑定一致；
- 只有验证通过后才替换镜像、快照和 latest。

代码位置：`src/assets/asset-sync-service.ts:591-690`。

## 2. 独立验证

- T03/T04/T20：旧 generation 的实时响应不能复活旧 generation，也不能覆盖新 latest。
- T05：快照插入失败回滚镜像和 latest。
- T06：latest 唯一索引冲突不产生半写状态。
- T17a/T17b：解绑与提交两种线性化顺序均有明确结果。
- 关键组连续 5/5 次通过。

## 3. 结论

协调器 generation 单调递增，旧的协调器任务不能绕过最终 fencing。latest 的数据库唯一性有效。

但全系统不满足“只有当前有效任务可写镜像”：

- F-P9335-03：generic `syncAssets()` 不参与 lease/generation/fencing。
- generic 写入可使 `character_assets` 与协调器 latest 快照分叉。

## 4. 残余 P2 风险

1. `src/assets/asset-sync-worker.ts:20-33` 的调度查询排除所有 RUNNING job，却不先调用 `reclaimStaleJobs()`。若进程崩溃后没有人工/API 触发回收，scheduled worker 可能永远不会再次选中该角色。
2. `renewed_at` 只在 `acquireOwnership()` 写入，未发现心跳续期；过期判断使用不可变 `started_at`。长时间合法同步可能被新任务回收。

两项均未改变本轮“P1 已失败”的结论，但应作为后续修复项。

## 5. 证据等级

- 代码/schema：已验证。
- 隔离并发与崩溃：已验证。
- 调度器长时运行和生产时钟/负载：尚未真实验证。
