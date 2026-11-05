# 资产同步 generation 与 fencing

## 1. 所有权令牌

每次成功申请都会固定：

- `jobId`
- `characterId`
- `generation`
- `owner_user_id`
- `owner_chat_id`
- `binding_epoch`
- `binding_digest`
- `account_owner_hash`

持久化 lease 记录 `character_id`、`generation`、`job_id`、`acquired_at` 和 `renewed_at`。job 与 lease 在同一个 `BEGIN IMMEDIATE` 事务中建立。

## 2. 最终提交复核

`syncCharacter()` 的最终事务再次执行以下检查：

1. job 仍为 RUNNING；
2. job.characterId 与目标一致；
3. job.generation 与 ownership 一致；
4. owner user/chat 与冻结的 binding 一致；
5. binding epoch/digest 未变化；
6. account owner hash 未变化；
7. lease 仍由同一 generation/jobId 持有；
8. 当前用户、角色链接、scope 和 owner hash 与启动时一致；
9. job 完成更新必须命中 `status = RUNNING` 且 generation 匹配；
10. lease 在同一事务内删除。

任何检查失败都会回滚 mirror、snapshot、snapshot items、changes、job 完成状态和 lease 释放，随后由失败路径只对仍有效的 ownership 标记 FAILED。

## 3. 旧任务隔离

旧任务即使已经拿到完整 ESI 响应，也不能：

- 复活旧 generation；
- 修改新任务的 job 状态；
- 删除新 generation 的 lease；
- 将旧快照设为 latest；
- 删除或覆盖当前 mirror；
- 写入与当前 generation 不一致的 snapshot 事实。

## 4. 快照原子性

以下操作位于同一个事务：

- 删除并重建 `character_assets` mirror；
- 将旧 latest 标记为非 latest；
- 插入新 COMPLETED snapshot；
- 插入 snapshot items；
- 插入 observed changes；
- 将 job 标记 COMPLETED；
- 释放 lease。

`idx_real_asset_snapshots_latest` 保证每角色至多一个 latest。事务失败或进程在提交中被杀时，上一份 latest 和 mirror 保持不变。

## 5. 测试证据

| 测试 | 场景 | 预期与结果 |
|---|---|---|
| T03/T04/T20 | 旧 generation 慢响应，新 generation 先完成 | 旧任务失败，新 latest 保持，通过 |
| T05 | 注入 snapshot insert 失败 | mirror 回滚，旧 latest 保留，通过 |
| T06 | latest 唯一索引冲突 | 无半成品 mirror/snapshot，通过 |
| T19 | 相同资产重复同步 | 不重复创建 snapshot；旧 hash version 不去重，通过 |
| T01 | 两进程只产生一个 generation 1 owner | 通过 |
| T07 | stale RUNNING 回收后 generation 2 | 通过 |
| T08 | 提交中 SIGKILL | 旧 latest/mirror 保留，通过 |

## 6. 结论

在所测路径中，generation、lease 和最终事务复核共同保证旧任务不能覆盖新快照。未在真实多主机或网络文件系统上验证 SQLite WAL 行为；本项目部署形态的跨进程测试覆盖的是同一 Linux 文件系统上的独立进程。
