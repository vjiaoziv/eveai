# 01 钱包同步、能力快照与角色身份

## 验证状态

- 已通过代码验证。
- 已通过隔离 SQLite 与服务/路由测试验证。
- 未通过真实 ESI、真实 OAuth 和真实角色环境验证。

## 主动能力快照

P93EsiEvidenceService.syncWalletTransactions() 在发起钱包请求前构造固定上下文：

const pinnedCtx = { ...ctx, characterId };

随后主动调用 getEveCapabilities(db, 'P9.3 wallet transaction sync', pinnedCtx)。该调用基于当前数据库中的角色 scopes 重新建立能力快照，不依赖用户此前是否调用过其他 ESI 功能。

同步检查：

- capabilities.authenticated 必须为 true；
- capabilities.characterId 必须等于目标 characterId；
- grantedScopes 必须包含 esi-wallet.read_character_wallet.v1；
- 缺少 scope 时返回 WALLET_SCOPE_MISSING，并给出重新授权的可操作说明。

即使旧快照仍存在，服务也在每次同步中重新建立快照。测试将时间推进超过快照 TTL 后，同步仍能成功建立新快照并发起 ESI 请求。

## 固定角色上下文

- 路由先解析目标角色，再把 characterId 显式传给钱包同步服务。
- 服务在完整调用链使用 pinnedCtx。
- 所有 callEsiOperation() 调用都使用 pinnedCtx。
- character_id 参数始终为目标角色。
- ESI 客户端对认证请求用 Access Token 绑定角色覆盖路径中的 character_id。
- getLinkedCharacter() 在 pinned context 下只解析指定角色，不回退到活动角色。
- getAccessToken() 返回的 token.characterId 必须与目标角色一致。

因此，执行期间即使用户把活动角色切换到 B，URL、Authorization、证据、REAL 记录和同步游标仍绑定角色 A；任何所有权失效都会中止写入。

## 身份终检

同步在以下时点重新检查用户、聊天、角色链接和账户所有权：

1. 请求分发前；
2. 每页 ESI 请求前；
3. 全部分页响应接收后、持久化前；
4. 每笔交易事务开始和提交前；
5. 失败记录写入前后；
6. 游标更新事务提交前。

发现角色解绑、所有权变化或上下文失效时返回 IDENTITY_CHANGED 或 IDENTITY_UNAVAILABLE，不继续写交易、不写证据、不推进游标。SSO 所有权隔离逻辑未被修改。

## 路由错误语义

- WALLET_SCOPE_MISSING、IDENTITY_UNAVAILABLE、IDENTITY_CHANGED：HTTP 403。
- ESI_REQUEST_FAILED：HTTP 502。
- TRANSACTION_DATA_INVALID、TRANSACTION_IMPORT_FAILED：HTTP 422。
- 应用内 /esi-wallet-sync 路由本身是 POST 动作，但它发出的 ESI 请求仍是只读 GET。

## 测试证据

- 缺少钱包 scope 时不调用 ESI，返回可操作 403。
- 能力快照缺失或过期时会重新建立快照。
- 请求期间切换到角色 B，URL、token、证据、REAL 记录和同步状态仍绑定角色 A。
- 请求期间解绑角色 A，返回 403/IDENTITY_CHANGED，无交易、证据或游标写入。

## 缓存身份隔离补充

钱包分页调用使用 bypassCache: true。原因不是绕过授权，而是 ESI 缓存条目无法区分