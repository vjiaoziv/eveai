# 09 资产 item-set 完整性

## 1. 问题

资产镜像的“完整性”不能只看总数。两个 item set 可能具有完全不同的 item_id、type_id、location 或 parent 关系，但恰好拥有相同的行数、唯一类型数、地点数和总数量。旧逻辑会误报 `COMPLETE`。

## 2. 规范表示

`computeCanonicalAssetHash()` 对每个 item 的语义字段规范化并排序后计算 SHA-256：

- `itemId`
- `typeId`
- `quantity`
- `locationId`
- `locationType`
- `locationFlag`
- `isSingleton`
- `isBlueprintCopy`
- `parentItemId`
- canonical version

输入顺序不影响结果；每个字段必须保持类型语义，不能把未知值变成 0。当前版本由 `CANONICAL_ASSET_HASH_VERSION` 标识。

## 3. 镜像和快照比较

完整性检查同时读取：

- `hash_algorithm = sha256`
- `canonical_version`
- snapshot `data_hash`
- 当前 lineage 的 mirror canonical hash
- 行数、唯一类型、地点和 quantity 汇总

只有当规范 item-set 哈希一致且聚合信息一致时，才判定 `COMPLETE`。仅有聚合计数一致时仍为不一致。

## 4. 安全数量

汇总数量使用 BigInt 安全累加；超过 `Number.MAX_SAFE_INTEGER` 时拒绝提交，不使用浮点四舍五入掩盖溢出。单行数量和 item 数量也在 ESI 边界严格验证。

## 5. 原子性

验证全部通过后才允许在一个 `BEGIN IMMEDIATE` 事务中替换当前 lineage 的 mirror 和 snapshot item set。验证失败、分页不完整、身份变化或写事务失败均保留上一份有效数据。

历史 snapshot 行不因 latest 改变而删除；旧 generation 仍可通过固定 snapshot_id 查询，并等待独立的保留策略处理。

## 6. 测试证据

- `tests/unit/p9-3.3.4-asset-canonical-hash.test.ts`
- `tests/unit/p9-3.3.4-asset-character-context.test.ts`
- `tests/unit/p9-3.3.4-asset-migration.test.ts`
- `tests/unit/p9-3.3.6-safe-quantity-aggregation.test.ts`
- `tests/audit/p9-3.3.8/asset-snapshot-pagination.test.ts`
- 修复前反例：`tests/audit/p9-3.3.7/asset-consistency-audit.test.ts`

## 7. 限制

规范哈希仅证明镜像和已保存快照的 item-set 表示一致，不证明 ESI 返回的资产与真实 EVE 状态在时间上完全同步；真实分页和真实角色资产变化尚未验证。
