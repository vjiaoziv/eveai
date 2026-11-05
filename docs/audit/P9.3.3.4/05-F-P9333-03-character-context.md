# F-P9333-03：pinned characterId 全链路一致性

## 1. 入口身份规则

`syncCharacter(db, characterId, ctx, trigger)` 首先要求：

- target characterId 是正安全整数；
- `ctx.characterId` 存在且严格等于 target；
- `ctx.userId` 是有效正整数；
- `ctx.chatId` 若存在则必须是有效非零安全整数。

冲突在 job 创建、lease 获取和 ESI dispatch 之前立即拒绝。

## 2. 能力、scope 与 token

服务使用固定上下文 `{ ...ctx, characterId }`：

1. `readBindingSnapshot()` 校验账户 user ownership、对应 chat 链接和 `esi-assets.read_assets.v1`；
2. 每次同步主动调用 `getEveCapabilities()` 重建当前能力快照；
3. 能力快照的 characterId 必须等于 target；
4. granted scopes 必须包含资产读取 scope；
5. `getAccessToken()` 返回的 characterId 必须等于 target。

能力快照 Map 只服务 ESI client 的短期 dispatch gate；服务本身不会把旧 snapshot 当成授权结论。每次同步都会重新读取账户 scope 并重新建立快照。

## 3. ESI 路径绑定

ESI 私有操作在 `resolveAccess()` 中取得当前 token，并由 `prepareRequest()` 对认证操作使用 token 的 characterId 替换 `character_id` 路径参数。即使调用方传入不同值，认证路径仍绑定 token 角色；资产服务还会在 dispatch 前显式核对 token 与 target 一致。

资产请求固定为：

```text
GET /characters/{characterId}/assets
```

## 4. 用户切换活动角色

后台同步 context 显式固定 characterId。`resolveActiveCharacterId()` 在 pin 存在时走 `resolvePinnedCharacterId()`，不会回退到用户或 chat 的当前活动角色。T13/T14 和“request 期间切换 active character”测试证明不会发生跨角色 mirror 写入。

## 5. 测试证据

| 测试 | 场景 | 结果 |
|---|---|---|
| T13 | ctx=A、target=B | 无 job、无 mirror、无 fetch，通过 |
| T14 | token 属于 B、target=A | 无 job、无 fetch，通过 |
| scope | 缺少资产 scope | 返回可操作重新授权错误，通过 |
| capability | 能力快照缺失 | 主动重建后成功，通过 |
| active switch | 请求期间用户切换活动角色 | 仍请求并写入 pinned 角色，通过 |
| 历史反例 | target 与 pinned context 冲突 | 通过 |

## 6. 结论

F-P9333-03 已在代码和隔离测试中修复。没有修改 SSO 所有权隔离规则，也没有扩大任一角色的授权范围。
