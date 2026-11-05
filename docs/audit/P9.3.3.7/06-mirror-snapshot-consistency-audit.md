# 06 Mirror/Snapshot 一致性与详情截断审计

## F-P9337-02（P1）多 chat lane 删除他人 mirror

- 文件：`src/assets/asset-sync-service.ts:857`。
- 复现：同一 user 在同一 `character_id` 的 A、B 两个 chat lane 依次同步。
- 预期：A 的 mirror 和 snapshot 保持完整，B 只更新自己的 lineage。
- 实际：B 的 `DELETE WHERE character_id = ?` 删除 A 的 mirror；A 的 completed snapshot 仍在。
- 影响：overview 会把 A lane 的 mirror 当成不存在，forecast/机会匹配可能基于错误的当前库存；历史快照和当前 mirror 形成错配。
- 证据：`asset-consistency-audit.test.ts` F-P9337-02；`logs/p9337-expanded-audit.log`。
- 建议：删除条件加入 lineage predicate；同时扩展 mirror 键或使用每个 chat 的独立 mirror namespace。
- 阻断：是（P1）。

## F-P9337-03（P2）不同 item set 被标为 COMPLETE

- 文件：`src/web/asset-routes.ts:147-154`。
- 逻辑只比较 item 数、unique type 数、location 数和 quantity 聚合，不比较 canonical hash、item_id 集合和字段。
- 反例：snapshot 为 `type_id={34,35}`，mirror 为 `{34,36}`，但计数、unique type、location、quantity 全部相同。
- 预期：`dataIntegrity='INCONSISTENT'` 或 `STALE`。
- 实际：`dataIntegrity='COMPLETE'`。
- 影响：用户看到“完整”库存，但实际 item 集已不同；机会匹配/估值可能基于错误集合。
- 证据：`asset-consistency-audit.test.ts` F-P9337-03；隔离 SQLite（B 级）。
- 同类静态风险：`src/assets/opportunity-match-service.ts:99-110` 的 `currentSetIsConsistent()` 也只比较聚合，尚未做独立运行反例。
- 建议：使用 `CANONICAL_ASSET_HASH_VERSION` 的 canonical hash + snapshot items 全量比较；聚合只能作为快速预检，不能作为 COMPLETE 的唯一依据。
- 阻断：否（P2），但应在下一阶段修复。

## F-P9337-04（P2）详情接口静默截断 5000 条

- 文件：`src/web/asset-routes.ts:355-360`。
- `LIMIT 5000` 没有返回截断标志、total item count 或 continuation。
- 反例：snapshot 有 5001 条 items，API 返回 `snapshot.total_items=5001`，但 `items.length=5000`，且响应没有 `truncated`/`totalItems`。
- 影响：调用方可能把 5000 条当成完整详情，后续核对/导出/机会分析漏掉资产。
- 证据：`asset-consistency-audit.test.ts` F-P9337-04；隔离 SQLite（B 级）。
- 建议：返回明确 `truncated: true`、`returnedItems`、`totalItems`、cursor/offset；或改成分页并让前端显示截断状态。
- 阻断：否（P2）。

## 证据等级

以上均为代码验证 + 隔离 SQLite；无真实 ESI、真实生产数据库或真实多实例验证。
