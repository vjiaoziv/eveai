# P8.7 会计口径与 PnL 独立验证

## 会计恒等式

`PaperTradingSystem.verifyAccountBalance`（`src/trading/paper-trading.ts:238`）验证：

```text
实际资产 = available_cash + escrow_locked + holding.inventory_cost
期望权益 = initial_cash + total_realized_pnl - total_fees_paid
```

`total_realized_pnl` 保存卖出毛利，费用单独进入 `total_fees_paid`，避免“净额再扣费”的重复扣减。

## 卖出 FIFO 与退出记录

`src/trading/paper-trading.ts:849` 写入 `paper_position_exits`：

- 按 `created_at, paper_id` 消耗持仓批次。
- 记录每批 `quantity/cost_price/exit_price/gross_pnl`。
- 部分卖出减少批次数量，全部卖出标记 `sold`。
- 不再用订单限价冒充持仓成本。

## 库存估值

`src/trading/paper-trading.ts:842` 与 `performance-analytics.ts:96` 均按买盘深度逐档估值：

```text
可变现毛值 = Σ min(剩余数量, bid.volumeRemain) × bid.price
净变现值 = 可变现毛值 × (1 - 5.025%销售税 - 2.10%经纪人费)
未实现盈亏 = 净变现值 - 持仓成本
```

因此单个最优买价不会被直接乘以全部库存数量。

## 权益序列与回撤

`paper_equity_snapshots`（`src/db/migrations.ts:151`）在账户、下单、成交、撤单、过期时记录：

`available_cash / escrow_locked / inventory_cost / inventory_value / total_equity`

最大回撤由完整权益序列计算，而不是仅用最终余额。

## 独立测试样本

`tests/unit/p8-7-performance-runtime.test.ts` 在内存数据库中完成：

- 100 单位 @10 买入，100 单位 @12 卖出。
- 卖出毛利 200 ISK，总费用 106.5 ISK，净利 93.5 ISK。
- FIFO 退出毛利与 `paper_position_exits` 一致。
- 账本差异为 0。
- 深度 50@10 + 50@9 时，库存净变现值为 882.31 ISK，而不是 1000 ISK。

该测试不调用被测会计函数生成预期值，而是直接断言数据库结果。