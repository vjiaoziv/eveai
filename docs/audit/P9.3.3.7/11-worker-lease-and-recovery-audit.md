# 11 Worker、Lease 与恢复审计

## 独立恢复检查

`tests/audit/p9-3.3.7/historical-regression-audit.test.ts` 重新构造了以下场景，且在隔离 SQLite 中通过：

- R-P9335-01：插入超过 stale window 的 RUNNING job 和 lease；worker tick 将其标记 FAILED，随后新 job 完成并写入 mirror。
- R-P9335-02：阻塞 ESI fetch 超过一个 heartbeat 周期；`renewed_at` 更新而 `acquired_at` 不变，完成后 lease 被删除。
- A→B 所有权在 fetch 飞行中变化，重复 5 次；旧任务均被 fencing 拒绝，没有提交 snapshot、mirror 或遗留 lease。
- 钱包 fetch 飞行中的所有权变化由 `wallet-cursor-integrity-audit.test.ts` 覆盖，返回 `IDENTITY_CHANGED`，未写账本或推进游标。

## 代码检查

- `src/assets/asset-sync-service.ts` 的 lease 续期校验 job status、generation、job id、owner/chat、binding epoch、binding digest 和 lease 过期时间。
- 资产最终提交事务再次读取 binding/ownership，避免旧任务在转移后提交。
- 钱包同步有独立 lease 和 identity re-check。

## 回归结果

- P9.3.3.1..6 既有回归：33 文件 / 171 测试通过。
- P9.3.3.7 独立专项：6 文件 / 34 测试通过。
- 日志：`logs/p9337-historical-regression.log`、`logs/p9337-expanded-audit.log`。

## 未复现

本轮未复现 R-P9335-01/R-P9335-02 的已知失效路径，也未发现 in-flight 角色切换后的提交。

## 限制

- 未执行真实多进程、多实例、生产 SQLite 锁竞争和网络延迟注入。
- heartbeat 与 stale 时间使用配置桩，不能证明生产时钟漂移下绝对安全。
- 角色转移与非常长事务、崩溃窗口、数据库阻塞的组合未在真实环境验证。
- 证据等级：代码验证 + 隔离 SQLite；真实环境未验证。