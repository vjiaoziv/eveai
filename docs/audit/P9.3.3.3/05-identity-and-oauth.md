# 05 身份绑定、OAuth 与授权边界

## 1. 钱包同步固定角色上下文

入口接收 route-selected characterId，并立即构造：

~~~text
pinnedCtx = { ...ctx, characterId }
~~~

位置：src/trading/p9-3-evidence-service.ts:618-644。

之后全流程使用 pinnedCtx：

- linkedCharacterMatches 复核角色仍存在、仍关联且属于当前用户；
- getEveCapabilities 使用 pinnedCtx 建立当前能力快照；
- 检查 snapshot.characterId 等于目标角色；
- 检查 grantedScopes 包含 esi-wallet.read_character_wallet.v1；
- ESI 参数 character_id 固定为目标角色；
- 交易、证据、失败队列、游标均以 characterId 写入；
- 持久化前后与游标提交前后再次复核身份和租约。

## 2. 能力快照

src/eve/capabilities.ts 使用 user/chat + pinned character 作为独立快照 key，TTL 为 10 分钟。

钱包同步每次都主动调用 getEveCapabilities，不依赖其他功能是否使用过 ESI。快照过期会重新建立。

src/eve/esi-client.ts:148-164 要求私有 ESI 调用必须有 fresh capability snapshot，并从目标 ctx 获取 access token。

prepareRequest 对 authenticated 操作使用 token 绑定角色覆盖 character_id 参数，避免调用方路径参数与 token 角色分离。

## 3. 已通过的对抗测试

- 缺少钱包 scope 时返回 403，且不调用 ESI；
- 能力快照缺失或过期时重新建立；
- 用户切换活动角色后，后台同步仍使用请求开始时选择的角色；
- 目标角色在请求期间解绑，返回 403 且不写账本；
- 所有权变化或证据事务内解绑会回滚；
- 两个不同角色并发同步保持数据隔离；
- 同一角色并发同步由租约串行化。

## 4. 资产服务身份契约缺陷

F-P9333-03 说明 RealAssetSyncService 未强制 ctx.characterId 与目标 characterId 一致。当前调用路径暂未发现可达入口，但这不是安全的服务级不变量。

F-P9333-04 说明即使入口 ctx 正确，资产同步在 ESI 响应前也没有重新验证角色关联和所有权。独立测试在 assets 响应回调中删除角色链接后，服务仍提交资产和快照。

## 5. OAuth 检测边界

可以验证的本地状态：

- token 过期与刷新失败；
- 本地角色解绑；
- 本地所有权变化；
- 本地 scope 快照变化。

不能即时验证：

- 用户在 EVE 侧撤销授权但本地尚未观察到；
- 远端 token 撤销的传播延迟；
- ESI 在请求中途返回的撤销结果与本地数据库状态的同步。

因此不能声称具备“即时远端 OAuth 撤销感知”。生产验证必须覆盖撤销后下一次同步的真实行为。

## 6. 结论

钱包同步身份隔离和授权前置检查在当前源码与隔离测试范围内通过。

资产同步存在 F-P9333-03 与 F-P9333-04 两项 P2 身份/提交缺陷；远端 OAuth 撤销仍属于未验证生产风险。
