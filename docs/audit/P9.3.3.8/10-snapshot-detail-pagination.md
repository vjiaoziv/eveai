# 10 快照详情分页

## 1. 问题

旧 `GET /api/web/assets/snapshots/:snapshotId` 只返回最多 5000 行，且没有分页元数据。调用方无法区分“快照只有 5000 行”和“快照有 5001+ 行但被截断”。

## 2. 新契约

接口返回：

```json
{
  "snapshot": {},
  "items": [],
  "total": 0,
  "limit": 500,
  "offset": 0,
  "hasMore": false,
  "nextOffset": null
}
```

规则：

- `limit` 默认 500，合法正整数，最大 5000；
- `offset` 默认 0，合法非负整数；
- `total` 来自该 snapshot_id 的完整计数；
- `nextOffset` 仅在还有行时提供；
- 非法 query 回退到安全默认值，不扩大为无界查询；
- 跨 owner/snapshot 返回 404，不泄露存在性。

## 3. 快照 ID 固定

分页请求必须使用同一个 snapshot_id。每次请求都重新验证该 snapshot 属于当前 session 的 lineage；不能把“最新 snapshot”在分页中途替换成另一代 snapshot。这样旧 generation 的后续页仍能按固定 ID 读取，而 latest 变化不会造成页拼接错误。

## 4. 回归场景

`tests/audit/p9-3.3.8/asset-snapshot-pagination.test.ts`：

1. 创建 5001-item 历史 generation；
2. 同步更新的 latest snapshot；
3. 用旧 snapshot_id 读取第一页 500 行；
4. `hasMore = true`，`nextOffset = 500`；
5. 读取最后一页 1 行；
6. `hasMore = false`，`nextOffset = null`；
7. 同时读取 latest snapshot，确认只返回最新的 1 行，不把两代混在一起。

## 5. 前端状态

当前审计确认 `web/src/api.ts` 暴露了 snapshot 方法，但活动页面只调用 `assets.snapshots()` 列表；没有活动前端页面消费 `assets.snapshot()` 详情分页。因此不能声称已经完成 UI 分页体验。若未来加入详情页，必须显示 total/hasMore，并在需要完整集时遍历全部页面。

## 6. 状态

- API 分页契约：代码和隔离路由测试通过。
- 前端展示：未实现，非本阶段阻塞条件，但列入残余缺口。
- 真实浏览器视觉回归：未执行。

## 7. 最终校正（2026-11-05，取代第 5 节的前端状态）

第 5 节记录的是当时审计状态，现已被同一工作区后续实现取代。当前活动前端确实消费 snapshot detail 分页：

- `web/src/api.ts:250-255` 将 `limit`、`offset` 传给详情接口；
- `web/src/components/AssetScreen.tsx:88-95` 定义 `total/limit/offset/hasMore/nextOffset` 契约；
- `web/src/components/AssetScreen.tsx:201-217` 按固定 `snapshotId` 加载指定页；
- `web/src/components/AssetScreen.tsx:658-720` 显示页范围，并提供上一页/下一页按钮；
- `web/src/i18n-dictionary.ts:1855` 提供分页状态文案；
- 后端分页边界位于 `src/web/asset-routes.ts:352-396`。

验证分级：

- 已通过代码验证：分页参数、固定 snapshot ID、`hasMore/nextOffset` 返回契约已接入活动页面。
- 已通过隔离测试数据验证：`tests/audit/p9-3.3.8/asset-snapshot-pagination.test.ts:106-221` 覆盖 5001 条历史快照和分页边界。
- 已通过真实环境验证：无。
- 尚未验证：真实浏览器视觉回归、超大真实快照下的交互性能。
