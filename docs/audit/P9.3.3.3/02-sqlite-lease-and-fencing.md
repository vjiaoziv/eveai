# 02 SQLite 钱包租约与旧持有者隔离

## 1. 数据模型

钱包同步租约表位于 src/db/migrations.ts:817-822：

~~~text
real_esi_transaction_sync_leases
  character_id PRIMARY KEY
  owner_id
  acquired_at
  expires_at
~~~

character_id 主键提供角色级互斥。不同角色可使用不同租约，不会形成全局锁。

## 2. 获取语义

实现位于 src/trading/p9-3-evidence-service.ts:171-196。

使用单条 SQLite UPSERT：

- 不存在时 INSERT；
- 已存在且 expires_at <= now 时更新 owner_id、acquired_at、expires_at；
- 未过期时不更新，changes = 0；
- 等待窗口内轮询，超时返回 WalletLeaseUnavailableError。

这与“先 SELECT 再 INSERT”模式不同，竞争窗口由 SQLite 写事务与 ON CONFLICT 条件收敛。

## 3. 旧持有者隔离

已实现的保护：

1. ownsWalletLease 同时检查 character_id、owner_id 和 expires_at > now；
2. 每笔交易事务开始和结束都执行身份/租约复核；
3. 游标事务在写入前后执行身份/租约复核；
4. releaseWalletLease 同时匹配 character_id 和 owner_id，旧持有者不能删除新持有者租约；
5. 身份检查要求目标角色仍关联且属于当前用户。

相关位置：src/trading/p9-3-evidence-service.ts:164-217、373-384、413-497、526-581、613-615。

## 4. 隔离测试

通过的既有测试包括：

- 另一 SQLite 连接持有租约时，同步等待到显式释放后继续；
- 独立 Node 子进程持有租约时，主进程不得写入；
- 租约过期后可回收；
- 旧 owner 在租约被替换后不能提交；
- 不同角色并发同步互不污染；
- 较慢同步不能让游标回退；
- 游标写入失败后能够幂等恢复。

这些测试覆盖了跨连接和跨进程，不只覆盖同进程 Promise。

## 5. 租约状态机与获取/释放时序

### 5.1 租约状态机

~~~text
ABSENT
  │ 单条 UPSERT 成功
  ▼
HELD_VALID ── expires_at <= now ──► EXPIRED
  │                                  │
  │ release(owner_id 匹配)            │ 后续 UPSERT 可回收
  ▼                                  ▼
RELEASED                      HELD_VALID（新 owner）

HELD_VALID
  └── 身份、角色归属或 owner/expiry 复核失败 ──► 拒绝提交
~~~

说明：

- 当前实现没有明确的内存状态枚举，上图为数据库状态的行为模型；
- 没有实现续期，因此不存在 `HELD_VALID -> RENEWED` 转换；
- 过期不会自动删除记录，而是由下一次满足条件的 UPSERT 回收；
- 旧持有者释放时只按自己的 owner_id 更新，不能释放新持有者租约。

### 5.2 获取与释放时序

~~~text
进程A                          SQLite                         进程B
  │                              │                              │
  │ UPSERT char/ownerA/expiryA   │                              │
  ├─────────────────────────────►│                              │
  │ changes=1, 获得租约           │                              │
  │                              │ UPSERT char/ownerB/expiryB   │
  │                              │◄─────────────────────────────┤
  │                              │ ownerA 未过期: changes=0      │
  │                              ├─────────────────────────────►│
  │                              │                       等待/失败
  │ ESI 获取与本地校验            │                              │
  │ 事务前复核 owner/expiry       │                              │
  │ 逐笔事务前后复核              │                              │
  │ 游标事务前后复核              │                              │
  │ finally: release(ownerA)     │                              │
  ├─────────────────────────────►│                              │
  │                              │ 仅 ownerA 匹配时清空/释放      │
~~~

### 5.3 多连接与锁冲突记录

已执行的隔离证据：

| 场景 | 结果 |
|---|---|
| 另一 SQLite 连接持有同一角色租约 | 主连接等待，显式释放后继续；通过 |
| 独立 Node 子进程持有同一角色租约 | 子进程未释放前主进程不提交；通过 |
| 旧 owner 在租约被替换后提交 | 被 owner/expiry/事务复核阻断；通过 |
| 不同角色并发持有租约 | 可并行，无全局锁；通过 |
| 游标写入临时失败 | 保留可恢复状态并幂等重试；通过 |

尚未取得的证据：

- 持续 `SQLITE_BUSY` 到租约末期的确定性故障注入；
- WAL checkpoint 与租约回收同时发生；
- 生产文件锁异常；
- 进程强杀并重启后的完整恢复演练。

这些缺口不等同于已确认缺陷，但使生产多实例可靠性仍只能标记为“尚未验证”。

## 6. 残余风险

### R-01 无递增 fencing token

当前只有随机 owner_id，没有 lease generation/fencing token。SQLite 单写者、事务内复核和 owner 条件目前提供了较强的等价保护，但形式化上不如单调 fencing token 明确。

本轮没有构造出确定性绕过，因此不将其列为已确认缺陷，但生产多实例环境仍应验证。

### R-02 无租约续期

TTL 固定，且没有心跳续期。当前租约在 ESI 获取与校验完成后、开始持久化前才获取，降低长网络请求导致过期的概率；但大批量本地持久化仍可能触及 TTL。

若未来扩大单批数据量、降低 TTL 或启用更慢存储，必须增加续期或重新设计提交协议。

### R-03 提交边界未做确定性故障注入

源码在游标写入后、同一事务内再次检查租约；本轮未构造“恰好在此边界过期并被另一进程替换”的确定性测试。

当前结论是：未发现已确认绕过，但生产风险仍需保留。
