# Canonical asset hash 完整性

## 1. 实现

`computeCanonicalAssetHash()` 位于 `src/assets/asset-sync-service.ts:264-285`，版本常量为 `CANONICAL_ASSET_HASH_VERSION = 1`。

规范化字段：

- `itemId`
- `typeId`
- `quantity`
- `locationId`
- `locationType`
- `locationFlag`
- `isSingleton`
- `isBlueprintCopy`，明确区分 `null` 与 boolean
- `parentItemId`

数组按 `itemId` 排序，JSON 属性顺序固定，使用 SHA-256。

## 2. 独立测试

`tests/unit/p9-3.3.4-asset-canonical-hash.test.ts`：

- location_type 变化改变 hash。
- is_singleton 变化改变 hash。
- is_blueprint_copy 的 false 与 unknown 改变 hash。
- item/type/quantity/location/flag/parent 变化改变 hash。
- ESI 输入顺序变化不改变 hash。
- 非语义 raw 字段不改变 hash。
- 重复计算稳定。

## 3. 去重版本保护

协调器只对满足以下条件的 previous snapshot 去重：

- `data_hash` 相同；
- `hash_algorithm='sha256'`；
- `canonical_version=1`。

旧 canonical version 不能直接与当前版本比较。

## 4. 结论

canonical hash 本身：**通过**。

注意：hash 完整不代表去重生命周期安全。F-P9335-01 的缺陷在去重决策没有同时验证当前绑定/镜像状态，而不是 hash 少字段。

## 5. 证据等级

- 代码与单元测试：已验证。
- 真实 ESI 全部字段和未来 schema 变化：未验证；新增语义字段必须提升 canonical version。
