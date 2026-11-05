# 09 故障注入与恢复能力

## 1. 已执行的故障/并发场景

| 场景 | 证据 | 结果 |
|---|---|---|
| 另一 SQLite 连接持有租约 | p9-3.3.2-wallet-cross-connection-lease.test.ts | 通过 |
| 独立 Node 进程持有租约 | p9-3.3.2-wallet-multiprocess-lease.test.ts | 通过 |
| 旧 owner 在租约替换后提交 | p9-3.3.2-wallet-lease-integrity.test.ts | 通过 |
| 过期租约回收 | p9-3.3.2-wallet-lease-integrity.test.ts | 通过 |
| 游标写入失败后恢复 | p9-3.3.1-audit-wallet-concurrency.test.ts | 通过 |
| 低 ID 失败阻止游标推进 | p9-3.3-evidence.test.ts | 通过 |
| 分页超限/后续空页 | p9-3.3-evidence.test.ts、p9-3.3-wallet-routes.test.ts | 通过 |
| 身份在 ESI 响应后变化 | p9-3.3-evidence.test.ts、p9-3.3-wallet-routes.test.ts | 通过 |
| 角色在证据/游标事务内解绑 | p9-3.3.1-audit-wallet-concurrency.test.ts | 通过 |
| 重复同步幂等 | p9-3.3-evidence.test.ts、证据幂等测试 | 通过 |
| 资产第二页畸形 | p9-3.3.2-asset-integrity.test.ts | 通过 |
| 资产后续页失败 | p9-3.3.2-asset-integrity.test.ts | 通过 |
| 资产数据库提交失败回滚 | p9-3.3.2-asset-integrity.test.ts | 通过 |
| FIFO 重算失败保留旧结果并 STALE | p9-3.3-fifo.test.ts | 通过 |
| 两个独立进程同时启动资产同步 | p9-3.3.3-asset-race.test.ts | **失败** |
| 资产 ESI 响应期间角色解绑 | p9-3.3.3-asset-race.test.ts | **失败：仍提交资产和快照** |
| 资产响应畸形、重复 item_id、后续页失败、事务回滚 | p9-3.3.2-asset-integrity.test.ts | 通过 |

## 2. 资产并发故障的确定性构造

测试使用：

- 独立临时 SQLite；
- WAL 和 busy_timeout；
- 两个独立 Node.js 子进程；
- SQLite prepare Proxy 插入 barrier；
- 两个进程都完成 RUNNING 查询后，再允许继续；
- 子进程 B 先完成，子进程 A 再提交旧响应。

结果不是依赖随机 sleep 的偶发竞态，而是确定性交错。

实际失败有两种交错结果：

- 稳定现象：两个进程都通过 RUNNING 查询，数据库出现 2 个 job；
- 一种结果：两个 job 均 COMPLETED，snapshots=2，旧响应 quantity=1 覆盖较新的 quantity=2；
- 另一种结果：一个 job 在 latest 唯一索引处 FAILED，但两个 RUNNING job 已创建，同步结果依赖提交顺序。

新增角色解绑测试还确认：ESI 响应期间删除 `eve_character_links` 后，服务仍写入 1 条资产和 1 个快照。

## 3. 未覆盖的故障

- 进程在每条钱包交易提交之间被随机 SIGKILL；
- SQLite WAL checkpoint 与钱包游标提交并发；
- SQLITE_BUSY 持续到租约过期；
- 生产文件系统锁异常；
- 真实 ESI 429/500 与长分页；
- OAuth 远端撤销；
- 生产服务重启后的多实例恢复。

这些不是本轮已确认缺陷，但仍是生产验证缺口。

## 4. 恢复能力结论

钱包同步、证据幂等与资料同步的恢复设计在隔离测试中有效。

资产同步缺少跨进程单写者，且没有旧 generation 隔离，因此故障恢复设计不满足验收。

最终审计必须在资产反例保留并失败的情况下停止，不能删除该反例来追求门禁绿灯。
