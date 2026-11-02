# P8.7 六类策略绩效评估

## 实现状态

| 策略 | 扫描/分析能力 | Paper 链路 | 当前样本状态 |
|---|---|---|---|
| 站内套利 | `station-arbitrage.ts:16` 完整 scan | 可下单/成交 | `INSUFFICIENT_SAMPLE` |
| 跨贸易中心套利 | `regional-hauling.ts:58` 完整 scan | 可下单/成交 | `INSUFFICIENT_SAMPLE` |
| 市场做市 | 无专用扫描器 | 类型已定义 | `INSUFFICIENT_SAMPLE` |
| 趋势投资 | `trend-following.ts` 历史分析 | 无完整事件链 | `INSUFFICIENT_SAMPLE` |
| 事件驱动 | 仅有类型/辅助函数 | 无完整扫描和退出链 | `INSUFFICIENT_SAMPLE` |
| 产业链套利 | 再处理分析已实现 | 无完整生产/销售链 | `INSUFFICIENT_SAMPLE` |

生产数据库当前没有 Paper 订单和机会运行样本，因此六类策略均不得给出收益排名。

## 统一指标

实现位置：`src/trading/performance-analytics.ts:254`

- 成交率 = `filledOrders / submittedOrders`
- 机会兑现率 = `有订单的机会数 / 机会总数`
- 净收益率 = `netPnl / initialCapital`
- 资金利用率 = `平均(escrow + inventoryCost) / initialCapital`
- 最大回撤 = 权益序列峰值回撤
- 每策略净收益 = FIFO 退出毛利 - 该策略订单费用

零分母返回 `null`（前端显示 `N/A`），不返回伪造的 0%。

## 当前结论

全部策略状态为 `INSUFFICIENT_SAMPLE`。在样本达到 `MIN_SUBMITTED_ORDERS=10` 且 `MIN_COMPLETED_TRADES=5` 前，不进入 `PAPER_STRATEGY_VALIDATED`。