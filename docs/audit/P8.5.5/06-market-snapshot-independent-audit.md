# P8.5.5 行情快照独立审计

## 快照绑定实现

src/trading/trading-pipeline.ts:380-387：

- 从 originBook.sells 前 3 档提取 price 与 volumeRemain。
- 从 destBook.buys 前 3 档提取 price 与 volumeRemain。
- 对 JSON 内容计算完整 SHA-256。
- marketSnapshotHash 参与凭证签名。
- TradeOpportunity.marketSnapshotHash 与凭证一致性在 validatePipelineCredential 校验。

## 时效检查

- P8.5.5 A12：当买方或卖方市场快照过期时，TradingPipeline.evaluateCandidate 返回 D 级且不生成草案。
- A11：替换 marketSnapshotHash 后，即使重新签名，也会因机会与凭证快照不一致被拒绝。

测试位置：

- tests/unit/p8-5-5-a01-a24.test.ts:179
- tests/unit/p8-5-5-a01-a24.test.ts:191

## 独立问题

1. 快照哈希只覆盖每侧前 3 档，不覆盖完整订单簿。
2. 当前没有独立 marketSnapshotId 表；哈希可作为快照身份，但不能独立查询历史快照原件。
3. DataQualityMetrics 有 originSnapshotAgeMinutes、destSnapshotAgeMinutes、timestampSkewMinutes，但凭证没有携带 buySnapshotTimestamp 和 sellSnapshotTimestamp。
4. 市场快照 loader 可能直接分页读取 ESI，具体新鲜度依赖 data-center/market-snapshot-loader 的缓存时间。

## 结论

行情快照已从无绑定状态提升为内容哈希绑定，并具备过期拒绝和替换拒绝。由于缺少独立快照 ID、精确两侧时间戳和完整订单簿哈希，行情快照审计结论为 PARTIAL，不应表述为完全独立可追溯。
