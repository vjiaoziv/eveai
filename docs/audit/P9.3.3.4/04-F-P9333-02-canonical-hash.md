# F-P9333-02：canonical asset hash

## 1. 原缺陷

旧 hash 遗漏 `location_type`、`is_singleton` 和 `is_blueprint_copy`。资产语义变化时仍可能去重，导致 latest snapshot、mirror 和 observed changes 没有反映真实变化。

## 2. 版本 1 canonical representation

当前 `computeCanonicalAssetHash()` 对每行按 itemId 排序后包含：

- itemId
- typeId
- quantity
- locationId
- locationType
- locationFlag
- isSingleton
- isBlueprintCopy，但保留 `false` 与 `UNKNOWN(null)` 的区别
- parentItemId

哈希输入显式含 `version: 1`，算法为 SHA-256。非语义 raw JSON 字段不进入 hash，避免 ESI 无关字段导致虚假变化。

## 3. 历史兼容

`real_asset_snapshots` 新增：

- `hash_algorithm TEXT NOT NULL DEFAULT 'sha256'`
- `canonical_version INTEGER NOT NULL DEFAULT 0`

新快照写入 `sha256` 和版本 1。去重必须同时满足：

- `data_hash` 相同；
- `hash_algorithm = 'sha256'`；
- `canonical_version = 1`。

因此历史版本 0 hash 不会被当作当前 canonical hash，也不会阻止一次旧快照升级后的真实快照写入。

## 4. 缓存与可信快照

资产同步调用 ESI 时启用 `bypassCache: true`。ESI client 在可信资产快照路径上跳过 TTL cache，确保 mirror 基于当前 ESI 响应，而不是之前的缓存值。该选项不改变 GET-only 策略、鉴权或分页限制。

## 5. 测试证据

| 测试 | 变化 | 结果 |
|---|---|---|
| T09 | `location_type` | hash 与 snapshot 变化，通过 |
| T10 | `is_singleton` | hash 与 snapshot 变化，通过 |
| T11 | `is_blueprint_copy`，含 false→UNKNOWN | hash 变化，通过 |
| T12 | 输入 item 顺序变化 | hash 稳定，通过 |
| 补充 | 其余 P9.2 语义字段变化 | 均使 hash 变化，通过 |
| T19 | 相同 sync 去重；版本 0 不跨版本去重 | 通过 |
| 历史反例 | location type/singleton/blueprint-copy 联合变化 | 通过 |

## 6. 结论

F-P9333-02 已在代码和隔离测试中修复。没有重建或静默修改历史 snapshot hash，生产历史数据迁移影响仍需在部署前由运维审计确认。
