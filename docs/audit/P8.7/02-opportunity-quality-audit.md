# P8.7 交易机会质量审计（最终）

## 统一记录实现

`PaperTradingSystem.logOpportunity`（`src/trading/paper-trading.ts:285`）现在：

- 优先复用扫描/管线提供的 `opportunityId`。
- 保存买方与卖方 location、region、snapshotId、snapshot timestamp。
- 保存 `detected_at`、`expires_at`、`opportunity_status`。
- 保存 `executable_quantity`、`capital_required`、`logistics_cost`。
- 保存四层利润独立字段与 `profit_layers_json`。

`TradingPipeline.evaluateCandidate` 在生成机会对象后立即调用该函数（`src/trading/trading-pipeline.ts:553`），保证机会、草案、订单和 fill 使用同一 ID。

## 四层利润

| 层 | 字段 | 当前处理 |
|---|---|---|
| 理论毛利润 | `theoretical_gross_profit` | 买卖报价 × 数量 |
| 订单簿可执行毛利润 | `executable_gross_profit` | 有深度模拟时写入；否则 NULL |
| 费用后净利润 | `fee_net_profit` | FeeEngine 结果 |
| 综合净利润 | `comprehensive_net_profit` | 默认 NULL，状态 `UNKNOWN` |

资金占用、库存持有、未成交损失和风险折价无法可靠量化时保留在 `unknownCosts`，不填 0。

## 当前状态

字段缺口已补齐；但生产数据库没有机会样本，无法用真实数据验证利润预测方差。机会质量工程状态为 `IMPLEMENTED_PENDING_RUNTIME_SAMPLE`。