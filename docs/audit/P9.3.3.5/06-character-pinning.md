# Pinned character 全链路一致性

## 1. 协调器路径

`RealAssetSyncService.syncCharacter()`：

- 检查 target 与 `ctx.characterId` 一致并 pin 成新的上下文。
- 每次同步重建 capability snapshot。
- 检查 `esi-assets.read_assets.v1`。
- access token 必须属于目标角色。
- ESI path 使用 `character_id = characterId`。
- job、mirror、snapshot 和失败状态均使用该 characterId。
- 最终事务复核 binding digest/epoch 和 account owner hash。

代码：`src/assets/asset-sync-service.ts:431-490`、`591-690`。

## 2. 独立测试

- T13：矛盾 target/context 在副作用前拒绝。
- T14：其他角色的 token 在 job 创建和 ESI 派发前拒绝。
- 缺失资产 scope：返回可操作 reauthorization 错误。
- 缺失 capability snapshot：现场重建。
- 用户并发切换 active character：目标仍固定。
- 钱包相关 pinned character 测试也通过。

## 3. 全系统边界

generic `refreshCharacterDatasets(..., ['assets'])` 虽在调用时具有 characterId，但不获取协调器 job/lease，也没有最终 binding rewrite fence。F-P9335-03 的反例证明：

1. owner A 的 generic ESI 请求在途；
2. 角色解绑并重绑给 owner B；
3. A 的响应仍写回 B 当前角色上下文下的私有镜像。

因此：

- 协调器 pinned character：通过。
- 全系统 pinned/所有权一致性：不通过。

## 4. 证据等级

- 隔离 SQLite / 上下文切换：已验证。
- 真实 SSO 撤销、远端 token 撤销和生产 session 竞态：未验证。
