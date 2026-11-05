# F-01 资产镜像完整性与原子验证

## 原问题

角色资料资产同步可能先删除旧资产，再对响应逐行过滤。畸形行被跳过时仍可能提交部分资产集；RealAssetSyncService 也存在把字符串数值、非法枚举或部分分页响应当作有效数据的风险。

## 修复内容

- src/assets/asset-sync-service.ts
  - item_id、type_id、location_id、quantity 必须是正安全整数。
  - 不接受字符串数值转换。
  - location_type 只接受 ESI 枚举 station、solar_system、item、other。
  - location_flag 必须为非空字符串。
  - is_singleton、is_blueprint_copy 必须是 boolean。
  - 重复 item_id、无效 parent 关系和畸形行会使整批失败。
  - 所有页面先完整获取并验证，验证通过后才进入原子快照提交。
- src/eve/character-sync.ts
  - character_assets 镜像使用同样的严格字段验证。
  - 完整验证通过后才在单个 SQLite 事务中删除旧行并写入新行。
  - 任一字段、分页或数据库事务失败时保留上一份有效镜像。
- 修正旧测试夹具：ESI location_type 使用合法值 solar_system，而不是 system；没有放宽校验。

## 隔离测试

- tests/unit/p9-3.3.2-asset-integrity.test.ts：16/16 通过。
- tests/unit/p9-3.3.1-audit-asset-integrity.test.ts：4/4 通过。
- tests/unit/asset-sync.test.ts：9/9 通过。
- 覆盖畸形第二页、末页请求失败、数据库提交失败、字符串数值、字符串 boolean、零/负 ID、重复 item_id 和非法枚举。

## 验证结论

- 代码验证：通过。
- 隔离 SQLite 验证：通过。
- 真实 ESI 环境验证：未执行。
- 残留风险：真实 ESI 是否出现未枚举的新 location_type，需要在受控真实同步中观察。
