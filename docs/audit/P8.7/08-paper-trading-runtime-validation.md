# P8.7 Paper Trading 运行验证机制

实现：`src/trading/runtime-validation.ts:45`

## 运行门禁

| 门禁 | 判定 |
|---|---|
| `ledger_reconciliation` | 资产 = 初始资金 + 已实现毛利 - 费用 |
| `order_state_machine` | 状态、数量、终结态不变量 |
| `fill_integrity` | fill ID 唯一、数量不超订、费用与订单一致、无孤儿 fill |
| `temporal_integrity` | 订单、机会、快照、回测因果顺序 |
| `snapshot_freshness` | 有快照时检查未过期；无快照为 UNKNOWN |
| `opportunity_expiry` | 不存在仍在活动的过期机会 |
| `esi_read_only_boundary` | Paper API 无 ESI 写操作 |

任一 `FAIL` → `PAPER_TRADING_BLOCKED`；无失败 → `PAPER_TRADING_OPERATIONAL`。

## 可追溯链

运行报告输出：

`opportunitiesWithOrders / ordersWithFills / fillsWithOpportunity / orphanFills`

并输出六类策略的 `OK` 或 `INSUFFICIENT_SAMPLE`。

## 当前真实数据库状态

P8.5.6 基线数据库没有 Paper 账户、订单、成交和机会样本，因此：

- 受控内存测试可达到 `PAPER_TRADING_OPERATIONAL`
- 真实数据库策略评估必须保持 `INSUFFICIENT_SAMPLE`
- 不得输出 `PAPER_STRATEGY_VALIDATED`