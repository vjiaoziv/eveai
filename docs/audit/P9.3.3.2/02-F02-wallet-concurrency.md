# F-02 钱包同步并发与持久化租约

## 原问题

同一角色可由两个请求并发同步。慢请求可能基于旧游标覆盖新游标；终态 CAS 仅靠 JavaScript 不足以覆盖跨进程或多 SQLite 连接。

## 修复内容

- src/db/migrations.ts 新增 real_esi_transaction_sync_leases。
  - 以 character_id 为主键。
  - owner_id 标识当前同步请求。
  - expires_at 允许回收崩溃任务留下的过期租约。
- src/trading/p9-3-evidence-service.ts
  - 采用 SQLite UPSERT 获取租约，跨连接/进程可见。
  - 等待上限 5 秒，TTL 30 秒。
  - 单条交易写入前、写入后以及游标终态事务内均校验租约和身份。
  - 旧租约 owner 在租约被替换后不能继续提交。
  - 服务返回的 ok 与终态 status 保持一致；被其他请求失败记录阻塞时返回 ok:false、status:error 和实际持久化游标，而不是候选高游标。
- 游标 SQL 使用 CASE 保证新值不得小于现有值。

## 隔离测试

- tests/unit/p9-3.3.1-audit-wallet-concurrency.test.ts：8/8 通过。
- tests/unit/p9-3.3.2-wallet-lease-integrity.test.ts：5/5 通过。
- tests/unit/p9-3.3.2-wallet-cross-connection-lease.test.ts：1/1 通过。
- tests/unit/p9-3.3.2-wallet-multiprocess-lease.test.ts：1/1 通过。
- tests/unit/p9-3.3-wallet-routes.test.ts：5/5 通过。
- 跨进程测试由独立 Node 子进程持有临时 SQLite 中的同角色租约；子进程通过 stdout 明确确认 LEASE_ACQUIRED / LEASE_RELEASED，父进程通过 SQL 执行屏障确认已进入租约争抢。持锁期间不写入交易或游标，显式释放后才完成提交。该测试不使用随机 sleep 作为正确性依据。
- 覆盖慢请求回退、跨请求失败阻塞、跨 SQLite 连接租约、真实子进程租约、过期回收、旧 owner 接管、解绑和所有权变化。

## 验证结论

- 代码验证：通过。
- 隔离 SQLite 验证：通过。
- 隔离环境真实多进程验证：通过（单机、临时 SQLite、独立 Node 进程）。
- 生产多实例/长时间并发负载验证：未执行。
- 残留风险：30 秒租约在数万条真实成交的极端批次中可能过期并安全失败，需重试；当前没有租约续期机制。
