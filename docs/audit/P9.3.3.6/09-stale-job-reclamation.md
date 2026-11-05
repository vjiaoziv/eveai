# 09 Stale Job 回收

## 修复

scheduled worker 在挑选 due character 前先调用 `RealAssetSyncService.reclaimStaleJobs()`：

- 超过 stale window 的 RUNNING job 标为 FAILED
- 对应 lease 被撤销
- 回收幂等
- 回收失败时 worker 直接返回，不继续调度

## 防止旧任务复活

被回收的旧 generation 不能通过后续心跳恢复。新的同步获得更高 generation，旧 lease 的 job_id/generation 条件不再匹配。

专项测试覆盖自动回收后继续调度、活跃 job 不被回收、回收幂等、旧 generation 无法续期，以及回收 SQL 失败时 fail closed。
