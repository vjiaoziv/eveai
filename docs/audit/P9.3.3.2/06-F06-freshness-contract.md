# F-06 FIFO 计算结果新鲜度

## 问题

账本核实、冲正、更正、费用或证据状态变化后，旧 FIFO 结果可能仍被页面当作当前完整结果展示。

## 修复内容

- src/trading/p9-3-types.ts
  - 新增 CURRENT、STALE、NEVER_CALCULATED 状态。
  - 增加 latestCalculationAt、latestLedgerFactAt、latestFailedCalculationAt、message。
- src/trading/p9-3-fifo-service.ts
  - 比较最近成功计算完成时间与 VERIFIED/REVERSED/CORRECTED REAL 账本事实及事件时间。
  - 最新事实晚于成功计算时为 STALE。
  - 最近一次重算失败且晚于最近成功计算时为 STALE，同时保留上一次有效值。
  - 从未成功计算时为 NEVER_CALCULATED。
  - 不自动频繁重算；用户显式触发 recalculate 后才恢复 CURRENT。
- src/web/p9-routes.ts 的兼容 overview API 传播 freshness。
- src/web/p9-3-routes.ts 的 overview、performance 和 costs API 均传播 freshness；costs 返回 FIFO 批次/消耗及已实现字段，因此必须显式标记 STALE/NEVER_CALCULATED。
- src/trading/p9-ai-analysis.ts 的 REAL 确定性汇总完整携带 realAccounting.freshness 和 knownRealizedPnl。
- web/src/p9-freshness.ts 统一解析 freshness，并将 null 财务值格式化为 N/A。
- web/src/components/P93AccountingPanel.tsx 的 overview、库存成本、盈亏分析页面，以及 web/src/components/P9TradingScreen.tsx 对 STALE、NEVER_CALCULATED 和 UNKNOWN 展示警告；仍保留旧值但明确标注过期。
- 交易记录、证据中心、审计中心不展示 FIFO 盈亏；资产对账使用独立快照口径。逐项检查后，未发现这些页面把 FIFO 结果冒充 CURRENT。

## 隔离测试

- tests/unit/p9-3.3.1-audit-freshness.test.ts：1/1 通过。
- tests/unit/p9-3.3.2-freshness-contract.test.ts：3/3 通过。
- tests/unit/p9-3.3-fifo.test.ts 覆盖证据状态变化后 STALE、重算失败 STALE、显式重算 CURRENT。
- freshness-contract 独立验证兼容 overview、P9.3 ledger overview/performance/costs、AI REAL 汇总均保留 STALE 与 knownRealizedPnl；缺少 freshness 时前端契约返回 UNKNOWN，null/NaN 显示 N/A。
- npm run web:check 和 npm run build 通过。

## 验证结论

- 代码验证：通过。
- 隔离 SQLite/API 契约验证：通过。
- 浏览器人工视觉验收：未执行。
- 真实环境验证：未执行。
