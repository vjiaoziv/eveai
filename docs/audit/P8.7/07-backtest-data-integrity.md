# P8.7 历史数据与回测真实性审计

## 现有回测因果约束

`src/trading/backtesting/engine.ts:49` 的实现采用：

1. 信号日 T 只使用 `[T-14, T]` 历史窗口。
2. 入场严格在 T+1。
3. 出场严格在 T+2。
4. 循环在成交后跳过 T+1/T+2，避免同一批未来数据反向参与信号。

日频历史来自 `market_price_history`，不是订单簿快照。因此该回测属于“历史价格回测”，不能宣称为订单簿级真实成交回测。

## 独立时间审计

`PerformanceAnalytics.auditTemporalIntegrity`（`src/trading/performance-analytics.ts:480`）检查：

- `paper_fills.filled_at >= order.submitted_at/created_at`
- 机会 `detected_at <= order.created_at`
- 买/卖快照时间不得晚于机会发现时间
- `backtest_runs.metrics_json` 中必须 `signalDate < entryDate < exitDate`
- 无法解析的回测指标直接记为违规

时间字符串统一解析为毫秒时间戳后比较，避免 SQLite `YYYY-MM-DD HH:MM:SS` 与 ISO `T/Z` 格式造成误判。

## 数据质量边界

- 无快照元数据：标记 stale/UNKNOWN。
- 两地快照时差超过 15 分钟：机会 D 级否决。
- 快照过期：拒绝继续以旧价格成交。
- 深度不足：只允许部分成交或拒绝。
- 日均价、订单簿快照、实时 Paper Trading、真实交易四层结果必须分开标注。

## 泄漏测试

`tests/unit/p8-7-performance-runtime.test.ts` 包含：

- fill 时间早于订单提交 → `FAIL`
- 回测 signalDate 晚于 entryDate → `FAIL`

发现泄漏时审计状态为 `FAIL`，相关结果不得进入策略有效性结论。