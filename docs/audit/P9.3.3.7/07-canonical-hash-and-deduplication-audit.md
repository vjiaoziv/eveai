# 07 Canonical Hash 与去重审计

## 代码验证

- `src/assets/asset-sync-service.ts:299-317`：canonical hash 包含 itemId、typeId、quantity、location、flags、singleton、blueprint copy、parentItemId，并对 itemId 排序。
- `src/assets/asset-sync-service.ts:826-844`：去重必须同时满足：
  - 旧 snapshot 存在；
  - `data_hash` 相同；
  - hash algorithm 为 `sha256`；
  - canonical version 匹配；
  - `mirrorMatchesRows()` 对当前 lineage 做全量行比较；
  - `snapshotItemsMatchRows()` 对历史 snapshot items 做全量行比较。
- `mirrorMatchesRows()` 和 `snapshotItemsMatchRows()` 都检查行数、item_id 及关键字段，不是仅比较聚合数量。
- `p9-3.3.4-asset-canonical-hash.test.ts` 与 `p9-3.3.6-binding-aware-dedup.test.ts` 均通过。

## 结论

P9.3.3.6 的 canonical hash 和 binding-aware dedupe 设计本身未在本轮发现缺陷。历史 F-P9335-01 的“空 mirror 仍复用旧 snapshot”路径已被 running regression 覆盖，未复现。

## 但仍有展示层一致性缺陷

F-P9337-03 发生在 `src/web/asset-routes.ts:147-154`：overview 只比较 item count、unique types、location count、quantity sum，不比较 canonical hash 或完整 item set。因此：

- service 去重是严格的；
- UI 的 `dataIntegrity='COMPLETE'` 却可能在不一致 item set 上误报；
- 不能把“去重实现测试通过”解释为“所有一致性展示都正确”。

同类静态风险：`src/assets/opportunity-match-service.ts:99-110`。

## 证据等级

- 代码验证：是。
- 隔离 SQLite：canonical tests 通过；F-P9337-03 有专项反例。
- 真实环境：否。
