# 12 并发和竞态测试

## 1. 并发风险

P9.3 的竞态主要来自四类边界：

1. 角色在 ESI 请求期间被切换、解绑或转移；
2. 两个钱包同步同时获取游标/租约；
3. 资产同步的旧 generation 在 newer commit 后到达；
4. 多进程 SQLite 连接同时争用 lease 和 RUNNING job。

## 2. 防护

- 钱包同步使用短 TTL lease + `BEGIN IMMEDIATE`；
- 每次网络请求前后校验固定角色仍属于当前 owner/chat/epoch；
- 游标只取安全最大值，旧任务不能回退；
- 资产同步使用 generation、lease owner、heartbeat 和 binding fence；
- mirror、snapshot 和 latest 状态在同一事务中提交；
- 身份或 lease 失配时回滚；
- 不通过放宽 SQLite 锁或触发器换取并发通过。

## 3. 本次重复验证

执行 5 次下列 9 个文件：

```text
tests/unit/p9-3.3.1-audit-wallet-concurrency.test.ts
tests/unit/p9-3.3.2-wallet-cross-connection-lease.test.ts
tests/unit/p9-3.3.2-wallet-lease-integrity.test.ts
tests/unit/p9-3.3.2-wallet-multiprocess-lease.test.ts
tests/unit/p9-3.3.3-asset-race.test.ts
tests/unit/p9-3.3.4-asset-fencing.test.ts
tests/unit/p9-3.3.4-asset-unbind-race.test.ts
tests/unit/p9-3.3.5-asset-race.test.ts
tests/unit/p9-3.3.6-lease-heartbeat.test.ts
```

结果：

- 每轮 9 文件 / 36 用例通过；
- 5/5 轮 exit code 0；
- 日志：`logs/19-concurrency-repeat-5x.log`。

## 4. 语义验证

测试包含：

- 同一角色切换活动角色后，原始请求仍发往固定角色 A，写入不落到 B；
- 目标角色解绑后，不产生交易、证据或游标；
- 同一 wallet lineage 的租约互斥；
- 不同 owner/chat/lane 可独立游标和租约；
- 旧资产 generation 不能复活或覆盖 newer snapshot；
- 进程暂停后 heartbeat/lease 失效，旧 owner 被 fencing；
- stale RUNNING job 可回收，但回收不会重放旧数据。

## 5. 未覆盖

- 真实多主机、网络分区、主机时钟漂移；
- 真实 SQLite WAL 在长时间生产负载下的锁延迟；
- 真实进程崩溃发生于 commit 前/后的精确窗口；
- 真实角色 unlink 与 OAuth refresh 的竞态。

因此只能声明隔离 SQLite 多连接/多进程验证通过，不能声明生产并发已验证。

## 6. 最终并发证据校正（取代第 3 节的旧计数）

最终 5 轮并发回归实际执行 10 个文件，而不是旧记录的 9 个：

- 原有 9 个钱包/资产 lease、race、fencing 和 heartbeat 文件；
- 新增 `tests/audit/p9-3.3.8/real-ledger-multiprocess-ownership.test.ts:231-312`，使用两个独立 SQLite 连接和两个子进程验证 stale owner/new owner 均不能冲正旧账本事实。

结果：

- 每轮 10 files / 37 tests 通过；
- 5/5 轮均通过；
- 日志：`logs/21-concurrency-repeat-5x-final.log`。

该测试同时检查旧记录状态、审计事件数和证据数均未变化。结论仍仅限隔离 SQLite 多连接/多进程验证；未验证真实多主机、生产 WAL 负载或真实 OAuth/角色转移。
