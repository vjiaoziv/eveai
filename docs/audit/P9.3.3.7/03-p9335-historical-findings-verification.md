# 03 P9.3.3.5 历史缺陷独立复核

## 复核方式

本轮没有仅依赖既有修复测试或开发者报告，而是在 `tests/audit/p9-3.3.7/historical-regression-audit.test.ts` 中重新构造 P9.3.3.5 的关键反例，并调用当前生产服务、路由和隔离 SQLite：

- F-P9335-01..06：6 个独立场景。
- R-P9335-01..02：stale worker 回收与 lease 心跳续期。
- 额外重复 5 次角色所有权在资产请求飞行中变化的 fencing 检查。
- 文件结果：13/13 通过。
- 日志：`logs/p9337-expanded-audit.log`。
- 同时执行 P9.3.3.1..6 既有回归：33 个文件、171 项测试通过，日志为 `logs/p9337-historical-regression.log`。

## 逐项结果

| 编号 | 独立重建结果 | 本轮证据 | 限制 |
|---|---|---|---|
| F-P9335-01 | 未复现 | 解绑/重绑并清空 mirror 后，`deduped=false`，生成新 snapshot；当前 lineage 只有一个 mirror 行且 latest 指向新 snapshot | 隔离 SQLite；未验证生产迁移中的历史脏行 |
| F-P9335-02 | 未复现资产镜像/快照/标签跨 owner 暴露 | 所有权转移后，新 owner 只看到新 snapshot/job、当前 inventory 和空 tag 集合；旧 snapshot detail 返回 404 | 该测试只证明资产域；REAL 交易/证据域另有 F-P9337-01 |
| F-P9335-03 | 未复现 | generic asset refresh 经 `RealAssetSyncService`，mirror 数量与 snapshot 数量同步更新，旧 snapshot 被替代 | 单进程隔离测试；未验证多实例交错 |
| F-P9335-04 | 未复现 | 缺失 `X-Pages` 时同步抛错，上一完整 snapshot 和 mirror 保留 | 未连接真实 ESI |
| F-P9335-05 | 未复现 | 多条 `MAX_SAFE_INTEGER` 聚合溢出时 fail closed，上一 snapshot/mirror 保留 | 未覆盖所有 NUMBER 边界 |
| F-P9335-06 | 未复现 | 非数组 journal 响应报错；注入第 4 条写入失败后事务回滚，原 journal 行保留，状态为 error | 使用 SQLite trigger 注入失败，不是真实磁盘故障 |
| R-P9335-01 | 未复现 | 过期 RUNNING job 被标记 FAILED 并释放 lease，随后新任务完成并写入 mirror | 依赖配置桩，未做真实多实例 |
| R-P9335-02 | 未复现 | ESI fetch 阻塞期间 heartbeat 更新 `renewed_at`，`acquired_at` 不变；完成后 lease 删除 | 测试时序受调度器影响，不能替代生产压力测试 |
| 角色切换 fencing | 通过 | 在 fetch 调用内执行 A→B 转移，连续 5 次均拒绝提交，资产 snapshot/mirror/lease 均为 0 | 单进程、单连接 |

## 结论

P9.3.3.5 已修复路径在本轮独立反例和既有回归下未出现回退。但这只能说明资产同步与 journal 修复有效，不能覆盖 P9.3.3.6 未处理的 REAL 账本 owner lineage 和钱包游标继承问题。

证据等级：代码验证 + 隔离 SQLite 测试数据验证。真实环境尚未验证。