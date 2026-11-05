# 04 角色资料同步数据完整性

## 验证状态

- 已通过代码验证。
- 已通过隔离 SQLite 测试验证。
- 未通过真实 ESI 角色资料验证。

## 钱包余额

syncWallet() 不再把非法响应默认为 0。

- 响应必须是有限的 JavaScript number。
- 非数字、NaN、Infinity、字符串和负数均使本次 wallet dataset 同步失败。
- 失败时不更新 character_wallet.balance 和 synced_at。
- character_sync_state.status = error 与 error 单独记录。
- synced_at 继续表示最后一次成功同步时间，不被失败覆盖。
- 数据集状态只在请求成功、响应验证成功和数据库写入成功后写为 ok。

## 资产同步架构

通用资料同步的 syncAssets() 现在是兼容适配器，不再自行先删旧行再逐条过滤。

它显式绑定目标角色并委派 RealAssetSyncService.syncCharacter()：

1. 读取并校验当前角色/聊天/账户绑定。
2. 每次重建能力快照并检查 esi-assets.read_assets.v1。
3. 获取属于目标角色的 Access Token。
4. 获取任务租约和 generation/binding fencing 令牌。
5. 读取全部分页并验证响应为数组。
6. 全量验证每一行，任一关键字段错误即中止。
7. 在同一事务内检查任务、租约、角色绑定和账户所有权。
8. 只有完整验证和最终授权通过后，才原子替换 character_assets，并提交 real_asset_snapshots、快照明细和变更记录。
9. 验证、授权或数据库提交失败时保留上一份有效镜像和快照。

资产关键字段校验：

- item_id：正整数，批次内唯一；
- type_id：正整数；
- location_id：正整数；
- quantity：正整数；
- location_type：必须是 station、solar_system、item 或 other；
- location_flag：非空字符串；
- is_singleton：严格 boolean；
- is_blueprint_copy：省略可为 null；存在时必须是 boolean。

## 状态语义

明确区分：

- ESI 请求成功；
- 响应结构与字段验证成功；
- 数据库原子提交成功。

只有三者全部成功才写 dataset 状态 ok。资产同步还额外区分 RUNNING、COMPLETED、FAILED 任务状态，并保留历史快照和变更记录。

## P9.2 兼容性

P9.2 RealAssetSyncService 的原子快照、历史保留、规范哈希、租约和绑定 fencing 机制保持有效。通用资料同步通过其协调器提交，不再存在绕过协调器的第二条写入路径。

## 测试证据

- 钱包先成功写入有效余额；随后非法响应返回 error，余额和成功时间保持原值。
- 资产先成功写入旧集合；随后响应含不完整行时整体失败，旧集合和上一快照不变。
- 覆盖 quantity=0、非法 location_type、缺失 location_flag、字符串 is_singleton、非法 is_blueprint_copy 等异常输入。
- 覆盖角色重绑、陈旧任务提交、租约失效和 generic sync 必须走协调器的回归场景。

## 资产概览完整性补充

src/web/asset-routes.ts 的资产概览不再只比较聚合计数和旧数据哈希。最新快照查询显式读取：

- hash_algorithm；
- canonical_version；
- data_hash、total_items、total_unique_types、total_locations 和 total_quantity。

因此只有哈希算法、规范版本、当前镜像规范哈希和快照哈希全部匹配时才报告一致；聚合计数相同但 item 明细不同会报告 INCONSISTENT，不会再把完整快照误报为不一致。快照详情接口对大快照使用分页返回 total、hasMore 和 nextOffset，避免静默截断。

该行为由 tests/audit/p9-3.3.7/asset-consistency-audit.test.ts 覆盖：第二聊天保留第一 lineage、相同聚合计数不同明细报告 INCONSISTENT、5001 条快照详情返回首 500 条且 hasMore=true。
