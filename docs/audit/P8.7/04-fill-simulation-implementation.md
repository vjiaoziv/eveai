# P8.7 分级模拟成交实现

## 数据结构

`src/db/migrations.ts:111` 新增 `paper_fills`：

- `fill_id`
- `order_id`
- `opportunity_id`
- `snapshot_id`
- `filled_at`
- `price`
- `quantity`
- `fees`
- `remaining_quantity`
- `basis`
- `model_version`

费用按各档成交金额比例分摊，最后一档吸收两位小数舍入差，保证：

```text
SUM(paper_fills.fees) = paper_trading_orders.fees_paid
SUM(paper_fills.quantity) <= paper_trading_orders.quantity
```

## 执行入口

`src/trading/paper-trading.ts:606` 接受可选 `options`：

- `mode: immediate | limit_queue | stress`
- `visibleQueueAheadQty`
- `maxFillRatio`
- `adversePriceBps`

不同模式写入不同 `basis/model_version`：

| 模式 | basis | model_version |
|---|---|---|
| A | `counterparty_orderbook_level` | `eveai-paper-fill-v1-immediate` |
| B | `marketable_limit_queue` | `eveai-paper-fill-v1-limit-queue` |
| C | `stress_worsened_book` | `eveai-paper-fill-v1-stress` |

## 订单生命周期与权益快照

- 完整状态类型：`src/trading/paper-trading.ts:95`
- 状态迁移校验：`src/trading/paper-trading.ts:119`
- 订单创建事件：`src/trading/paper-trading.ts:496`
- 过期处理：`src/trading/paper-trading.ts:571`
- 权益快照：`src/trading/paper-trading.ts:162`

每次账户创建、订单创建、成交、撤单和过期都会写 `paper_equity_snapshots`，用于逐时点回撤计算。

## 测试

- `tests/unit/p8-7-fill-recording.test.ts`：2/2 通过
- `tests/unit/p8-7-fill-modes.test.ts`：2/2 通过
- `tests/unit/p8-7-fill-mode-integration.test.ts`：2/2 通过

Mode B/C 已从“仅模拟器方法”推进到 Paper Trading 执行链路可调用。