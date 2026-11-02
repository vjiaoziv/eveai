# P8.5.6 订单簿深度与可成交性审计

## 修复

原快照只哈希前三档。现在 src/trading/trading-pipeline.ts 计算 quantity-aware snapshot：

- 完整规范化 origin sells。
- 完整规范化 destination buys。
- requestedQuantity。
- buy/sell fill 的 requested、filled、unfilled、complete、effectiveOrders。

拟交易数量超过两侧可成交深度时，src/trading/trading-pipeline.ts:365-374 返回 D 级并明确拒绝。

OrderBookSimulator.findOptimalProfitableQuantity 继续跨多档计算加权价格、滑点和边际利润。

## 测试

tests/unit/p8-5-6-orderbook-depth.test.ts

- L12：10 件跨 3 档成交，买卖均 complete。
- L37：浅深度/倒置订单簿不外推顶档价格。
- L58：数量 5 而深度 4/3 时 partial fill，不允许授权完整数量。

结论：订单簿深度覆盖拟交易数量；不足时明确拒绝。
