# 04 资产写入统一

## 修复

`src/eve/character-sync.ts` 的 `syncAssets()` 不再自行删除或写入 `character_assets`，而是作为兼容适配器调用：

`RealAssetSyncService.syncCharacter(db, characterId, { ...ctx, characterId }, "auto", guard)`

## 协调器职责

`RealAssetSyncService` 统一负责：

- 固定角色上下文
- 能力/scope 与 access token 校验
- generation lease 获取与心跳
- 所有 ESI 页的完整获取和行验证
- canonical hash、去重和最终事务
- mirror、snapshot、items、changes、job 的原子提交
- 最终 ownership/binding fence

## 静态约束

专项测试扫描运行时源码，确认 `character_assets` 的 SQL 写入只出现在 `RealAssetSyncService`。测试允许非运行时/迁移性文本存在，但拒绝第二个运行时 writer。

## 结果

generic adapter 在协调器拒绝不完整响应时会返回失败，不会把 `character_sync_state` 标记为 `ok`。
