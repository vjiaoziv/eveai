# P8.7 Paper Trading 模拟成交真实性审计（更新）

日期：2026-11-02

## 审计对象

- `src/trading/paper-trading.ts:606`：`executeVirtualOrderAgainstBook`
- `src/trading/orderbook-simulator.ts:17`：Mode A `simulateBuy`
- `src/trading/orderbook-simulator.ts:77`：Mode A `simulateSell`
- `src/trading/orderbook-simulator.ts:142`：Mode B `simulateLimitOrder`
- `src/trading/orderbook-simulator.ts:211`：Mode C `simulateStressFill`
- `src/db/migrations.ts:111`：`paper_fills`

## 分级模式结论

| 模式 | 实现 | 保守性 | 局限 |
|---|---|---|---|
| A 立即吃单 | 已实现 | 按传入对手方订单逐档成交，不超 `volumeRemain` | 无法证明传入快照仍有效 |
| B 限价排队 | 已实现 | 只有立即可成交且 `visibleQueueAheadQty=0` 才成交 | 无 CCP 订单级真实队列 |
| C 压力成交 | 已实现 | `maxFillRatio` 限数量，`adversePriceBps` 恶化价格 | 是确定性压力情景，不是概率模型 |

Mode B 明确拒绝“价格触及限价即成交”：排队量大于零或限价不可立即成交时返回 `OPEN` 且不写 `paper_fills`。

Mode C 不使用随机数；同一输入产生同一结果，且成交数量不超过请求量。

## 状态机与成交明细

`src/trading/paper-trading.ts:106` 定义完整生命周期类型：

`CREATED → SUBMITTED → OPEN → PARTIALLY_FILLED/FILLED`，以及 `CANCEL_PENDING → CANCELLED`、`EXPIRED`、`REJECTED`。

数据库订单仍沿用 P8.5.6 的持久化状态（`open/partially_filled/filled/cancelled/expired`），完整生命周期通过 `paper_order_state_events`（`src/db/migrations.ts:179`）记录，避免破坏旧状态检查约束。

每笔成交写入 `paper_fills`，字段包含 orderId、fillId、opportunityId、snapshotId、价格、数量、费用、剩余量、依据和模型版本。

## 仍存在的真实性边界

1. 订单簿快照来自只读 ESI，成交前无法证明对手方订单仍然存在。
2. 没有真实订单队列位置，Mode B 必须由调用方提供可见排队量。
3. Mode C 的延迟、竞争和恶化程度是人工设定的压力参数。
4. Paper Trading 成交不等于真实市场成交，更不等于真实盈利。