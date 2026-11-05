# F-P9333-01：资产同步任务申请原子性

## 1. 原缺陷

旧实现先执行非权威 RUNNING 查询，再单独插入 job。两个独立进程可以同时通过查询并创建两个 job，随后依赖 latest 唯一索引决定谁成功，留下重复任务、提交冲突或旧响应覆盖风险。

## 2. 修复设计

### 2.1 角色级原子申请

`RealAssetSyncService.acquireOwnership()` 在一个 `BEGIN IMMEDIATE` 事务中完成：

1. 回收超过 stale window 的 RUNNING job 和 lease；
2. 检查当前是否已有有效 lease；
3. 计算该 characterId 的单调 generation；
4. 写入 RUNNING job 和 owner/binding 快照；
5. upsert 角色级 lease；
6. 返回 jobId、generation 和 binding token。

应用层 RUNNING 查询仍保留为快速 UX 拒绝路径，但注释和测试明确它不是所有权证明；真正的所有权只来自上述事务和数据库唯一约束。

### 2.2 数据库第二道约束

迁移新增：

```sql
CREATE UNIQUE INDEX idx_real_asset_jobs_one_running
ON real_asset_sync_jobs(character_id) WHERE status = 'RUNNING';
```

迁移前会把历史同角色重复 RUNNING job 中除最新者外标记为 FAILED，保留审计记录后再安装唯一索引。迁移测试验证了旧 schema 升级、重复 RUNNING 调和、唯一约束和重复执行幂等。

### 2.3 崩溃恢复

进程在任务创建后崩溃时，RUNNING job 和 lease 会保留。超过 `assetSync.staleJobMinutes` 后，下一次申请在同一事务中将其标记 FAILED、释放 lease，并为新尝试分配更高 generation。物理崩溃期间不会出现半提交的 mirror/snapshot。

## 3. 事务与不变量

- 同一角色同一时刻至多一个 RUNNING job；
- 同一角色同一时刻至多一个持久 lease 所有者；
- 不同角色使用独立 characterId 行，不引入全局锁；
- job 插入、generation 分配、owner 快照和 lease 写入要么全部成功，要么全部回滚；
- 旧 generation 不能提交快照；
- 失败任务不破坏上一份有效 latest snapshot 和 mirror。

## 4. 回归证据

| 测试 | 验证内容 | 结果 |
|---|---|---|
| T01 | 两独立进程竞争同角色，只产生一个 owned job | 通过 |
| T02 | 两独立角色可并发完成各自任务 | 通过 |
| T07 | 创建 job 后进程崩溃，可经 stale recovery 生成 generation 2 | 通过 |
| T08 | 提交事务中 SIGKILL，无半成品 latest 或 mirror | 通过 |
| migration | 旧表升级、重复 RUNNING 调和、唯一约束、幂等 | 通过 |

T01 的确定性顺序为：两个进程都先越过非权威 RUNNING 查询；B 获得 lease 并进入 ESI 后发屏障；A 再尝试原子申请并失败；B 等待 A 退出后提交。因此测试证明的是数据库申请互斥，而不是依赖随机时序。

## 5. 结论

F-P9333-01 在代码层和隔离 SQLite 双进程测试中已修复。未在生产数据库执行迁移或真实并发负载验证。
