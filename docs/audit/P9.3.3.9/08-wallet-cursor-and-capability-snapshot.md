# 08 钱包游标与能力快照

## 1. 角色固定上下文

`P93EsiEvidenceService.syncWalletTransactions` 在 `src/trading/p9-3-evidence-service.ts:730-793` 中：

1. 校验 `characterId` 为正安全整数。
2. 构造 `pinnedCtx = { ...ctx, characterId }`。
3. 解析固定 REAL lineage。
4. 使用 `linkedCharacterMatches` 校验用户/聊天与目标角色关联。
5. 再次确认 ownership snapshot。

ESI 路径参数固定使用 `character_id: characterId`；`callEsiOperation` 接收 `pinnedCtx`，并在分页期间通过 `identityCurrent` 再检查绑定。

路由 `src/web/p9-3-routes.ts:369-380` 把路由选定的 `char.characterId` 同时传给服务与 lineage。

## 2. 能力快照

`src/trading/p9-3-evidence-service.ts:773-792` 在每次钱包同步开始时无条件调用：

```ts
getEveCapabilities(db, 'P9.3 wallet transaction sync', pinnedCtx)
```

随后检查：

- `authenticated === true`
- `capabilities.characterId === characterId`
- `grantedScopes` 包含 `esi-wallet.read_character_wallet.v1`

缺 scope 时不发起钱包网络请求，并写入明确失败状态：

```text
缺少 esi-wallet.read_character_wallet.v1 权限，请在 EVE SSO 中重新授权角色钱包只读权限后重试。
```

该路径不依赖其他 ESI 功能是否先创建过快照，也不会以旧权限结果绕过当前 scope 检查。

## 3. 游标语义

`src/trading/p9-3-evidence-service.ts:620-705`：

- 计算候选边界。
- 查询 `transaction_id IS NULL OR transaction_id <= candidateBoundary` 的持久失败。
- 存在任何未解决失败时 `canAdvance = false`。
- 失败批次只在完整成功后清除。
- SQL 侧游标保持单调，不允许旧任务回写较小值。
- malformed row 使用稳定 failure key，阻塞游标但支持重试。
- 分页超预算或分页头不一致时在提交前返回失败。

## 4. 独立测试

`tests/audit/p9-3.3.9/wallet-adversarial.test.ts` 覆盖并通过：

- 无既往 ESI 使用时建立新能力快照。
- 缺钱包 scope 时在任何 ESI 请求前拒绝。
- 缺 scope 路由返回 HTTP 403。
- 路由选定角色在 active character 切换后仍保持 pinned。
- 同步期间 ownership 变化触发 fencing，且不写账本。
- transaction 100 失败、101 成功后游标仍不越过 100。
- malformed row 阻止游标推进。
- 超页数限制不提交事实或游标。
- owner 转移后游标隔离。

结果：相关测试全部通过。

## 5. 证据等级

- 代码验证：已完成。
- 隔离测试数据验证：已完成，使用 mock ESI 和隔离 SQLite。
- 真实环境验证：无。
- 尚未验证：真实 OAuth scope 刷新、真实 token 所属角色、真实 ESI 钱包分页与限流。
