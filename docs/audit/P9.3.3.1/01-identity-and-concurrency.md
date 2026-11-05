# 01. 身份隔离与并发竞态

## 审计范围

- `src/web/p9-3-routes.ts`
- `src/trading/p9-3-evidence-service.ts`
- `src/eve/esi-client.ts`
- `src/eve/capabilities.ts`
- `src/eve/sso.ts`
- `tests/unit/p9-3.3-evidence.test.ts`
- `tests/unit/p9-3.3-wallet-routes.test.ts`
- `tests/unit/p9-3.3.1-audit-wallet-concurrency.test.ts`

## 实际调用链

钱包同步路由：

```text
POST /api/web/trading/p9-3/esi-wallet-sync
-> requireMutationSession()
-> getLinkedCharacter() 取得请求入口角色 A
-> P93EsiEvidenceService.syncWalletTransactions(db, A, { userId, chatId })
-> pinnedCtx = { userId, chatId, characterId: A }
-> linkedCharacterMatches(db, pinnedCtx, A)
-> getEveCapabilities(db, intent, pinnedCtx)
-> callEsiOperation(..., { character_id: A }, pinnedCtx)
-> resolveAccess() 读取 pinnedCtx 对应角色和 Token
-> prepareRequest() 将私有 ESI character_id 绑定到 Token 角色
-> 每行事务：身份检查 -> ledger upsert -> evidence add -> evidence link -> 身份再检查
-> 最终身份检查
-> 写 real_esi_transaction_sync 游标
```

## 已通过代码与隔离测试验证

| 控制 | 证据 | 结果 |
|---|---|---|
| 请求入口固定目标角色 | `src/web/p9-3-routes.ts:308-317`；服务固定 `pinnedCtx` 于 `src/trading/p9-3-evidence-service.ts:180-187` | 通过 |
| 服务内部主动建立能力快照 | `p9-3-evidence-service.ts:189-209`；`capabilities.ts:24-72` | 通过 |
| 私有 ESI 要求新鲜能力快照 | `src/eve/esi-client.ts:130-158`；`capabilities.ts:85-96` | 通过 |
| 私有 ESI 路径和 Token 绑定角色 | `esi-client.ts:160-195`；测试验证 A/B 同时同步时 URL 和 Bearer Token 各自匹配 | 通过 |
| 请求中切换 active character 不污染目标角色 | `tests/unit/p9-3.3-wallet-routes.test.ts:153-181` | 通过 |
| ESI 响应后解绑或所有权变化会中止 | `tests/unit/p9-3.3.1-audit-wallet-concurrency.test.ts:270-286` | 通过 |
| 行事务内解绑会回滚记录与证据 | 同文件 `288-308` | 通过 |
| 不同角色并发同步保持隔离 | 同文件 `125-159` | 通过 |
| 缺少钱包 scope 返回 403 且不调用 ESI | `tests/unit/p9-3.3-evidence.test.ts:196-210`；路由测试 `134-151` | 通过 |
| 过期能力快照会重新建立 | `tests/unit/p9-3.3-evidence.test.ts:211-227` | 通过 |

## 已确认缺陷

### F-02（P1）同角色并发同步可越过另一任务的失败记录

涉及位置：

- `src/trading/p9-3-evidence-service.ts:211-215`（读取游标）
- `src/trading/p9-3-evidence-service.ts:316-425`（逐条处理）
- `src/trading/p9-3-evidence-service.ts:438-456`（计算并覆盖游标状态）

触发条件：

1. 角色 A 已存在安全游标 100。
2. 同步任务 X 获取到 transaction 150（畸形）与 200（合法）。
3. 同步任务 Y 同时只获取 transaction 200。
4. X 先将状态写为 `error`，游标保持 100。
5. Y 成功处理 200，并把游标和状态写成 `200 / ok`。

预期：

- 任何并发成功任务都不得越过另一任务未成功处理的低 ID。
- 游标最多停留在 100，或必须持久化待处理 transaction 150。

实际：

```text
期望：{ last_transaction_id: 100, status: 'error' }
实际：{ last_transaction_id: 200, status: 'ok' }
```

证据：

- 独立测试：`tests/unit/p9-3.3.1-audit-wallet-concurrency.test.ts:189-221`
- 实际失败断言在 `:220`

影响：

- transaction 150 可能在后续同步中被游标永久跳过。
- 成功任务会覆盖失败状态，用户无法看到仍有未处理记录。
- 属于真实财务证据和账本数据永久遗漏风险，定级 P1。

修复建议：

- 对同一 `characterId` 引入持久化同步租约/互斥，禁止两个任务同时进入游标提交阶段。
- 或引入持久化失败队列，游标只能推进到最小未解决失败 transactionId 之前。
- 终态写入使用数据库 CAS，例如仅允许 `newLastId >= currentLastId`，且在存在未解决失败时禁止写成 `ok`。
- 状态、错误和游标必须在同一数据库事务中完成。

### F-03（P2）慢速同角色同步可把游标回退

涉及位置：

- `src/trading/p9-3-evidence-service.ts:211-215`
- `src/trading/p9-3-evidence-service.ts:438-456`

触发条件：

- 两个同角色任务均从游标 100 开始。
- 先完成者处理 200，写入游标 200。
- 后完成者按旧快照又处理 150，最终覆盖为 150。

预期：终态游标至少保持 200。

实际：

```text
期望：{ last_transaction_id: 200, status: 'ok' }
实际：{ last_transaction_id: 150, status: 'ok' }
```

证据：`tests/unit/p9-3.3.1-audit-wallet-concurrency.test.ts:161-187`，失败于 `:186`。

影响：造成重复回扫、状态抖动和错误边界；若与错误状态交错，可能进一步诱发跳过。定级 P2。

### F-04（P2）最终身份复核与游标写入之间存在 TOCTOU

涉及位置：

- `src/trading/p9-3-evidence-service.ts:427-456`

触发条件：

- 服务完成最终 `linkedCharacterMatches()` 检查。
- 在随后执行 `INSERT ... real_esi_transaction_sync` 时，数据库触发器删除角色链接。
- 当前普通身份查询无法保护后续独立写语句。

预期：

- 返回 `IDENTITY_CHANGED`。
- 不提交游标。
- 已提交交易/证据必须与最终身份状态保持一致或失败关闭。

实际：

```text
期望：{ ok: false, errorCode: 'IDENTITY_CHANGED' }
实际：{ ok: true }
```

证据：`tests/unit/p9-3.3.1-audit-wallet-concurrency.test.ts:250-268`，失败于 `:266`。

影响：身份检查是“查询后写入”而不是同一事务内的原子断言；存在角色解绑/所有权变化后的成功响应和游标落库风险。定级 P2。

修复建议：

- 将最终身份断言、状态更新和游标更新放入同一个 `BEGIN IMMEDIATE` 事务。
- 在同一事务内读取 ownership/version/link 事实并写入游标。
- 增加角色所有权 token/version，CAS 失败时返回 `IDENTITY_CHANGED`。
- 不要仅依赖事务外多次普通 SELECT。

## 已验证与未验证边界

### 已通过代码验证

- `characterId` 不依赖后续活动角色重新解析。
- 私有 ESI 的 URL character_id 和 Token 角色由同一 private access 绑定。
- 身份失败在单行事务内有回滚路径。

### 已通过隔离测试数据验证

- 角色 A/B 并发隔离。
- 活动角色切换、解绑、所有权变化。
- 行事务内身份失效。
- 同角色并发游标反例（失败，确认缺陷）。

### 尚未验证

- 多进程部署下 SQLite 锁竞争和真实 HTTP 请求锁持有时间。
- 真实 EVE SSO 重新授权和 Token 刷新竞态。
- 生产数据库上角色链接更新与同步任务的实际调度并发。