# 12 FIFO UNKNOWN 成本与盈亏口径

## 1. 已实现盈亏

`src/trading/p9-3-fifo-service.ts:627-630` 分离：

```ts
const unknownConsumptionCount = Number(consumption?.unknown_count || 0);
const unknownOpenLotCount = Number(lots?.unknown_count || 0);
const realizedPnl = unknownConsumptionCount > 0
  ? null
  : roundMoney(Number(consumption?.known_pnl || 0));
```

只有“已卖出但成本无法确定”的 consumption 才使完整已实现盈亏为 N/A。未售出的 UNKNOWN open lot 不再污染已实现盈亏。

`knownRealizedPnl` 始终保留可确定部分，明确区别于完整已实现盈亏。

## 2. 胜率

确定性胜率只使用成本可确定的已完成卖出。某笔卖出只要包含 UNKNOWN FIFO consumption，该笔交易即从确定性胜率中排除。

结果对象同时提供：

- `unknownConsumptionCount`
- `unknownOpenLotCount`
- `knownRealizedPnl`
- 完整 `realizedPnl`

## 3. 未实现盈亏与库存成本

存在未售出 UNKNOWN lot 时：

- `inventoryCost = null`
- `capitalOccupied = null`
- `unrealizedPnl = null`

不会把未知开放库存成本伪装为 0 或确定金额。这与已实现盈亏的可确定性口径分开处理。

## 4. 独立测试

测试：`tests/audit/p9-3.3.9/fifo-adversarial.test.ts`。

| 场景 | 结果 |
|---|---|
| A：已知 A 已售，另有未售 UNKNOWN B | realized PnL 可计算；库存成本/未实现保持 N/A；通过 |
| B：一笔确定卖出加一笔 UNKNOWN_SOURCE 卖出 | 完整 realized PnL 为 N/A；knownRealizedPnl 保留；未知卖出计数准确；通过 |
| C：只有未售 UNKNOWN 库存，所有卖出成本已知 | 胜率仍可计算；通过 |
| D：一笔卖出跨已知/UNKNOWN 批次 | 该笔卖出不进入确定性胜率；通过 |
| E：重复 FIFO 重算 | 结果 hash 稳定，数量/成本/盈亏无不合理变化；通过 |

另有 5 轮 reversal/recalculation 确定性测试通过。

## 5. 新鲜度

`src/trading/p9-3-fifo-service.ts:109-195` 比较：

- 最新成功计算时间。
- 最新账本事实变化时间。
- 最新失败计算时间。

最新事实晚于最后一次成功计算，或失败尝试晚于最后成功计算时，返回 `STALE`；只有显式重算成功后才恢复 `CURRENT`。

测试 `fifo-adversarial.test.ts:189` 验证：核实买入计算后执行冲正，状态变为 `STALE`；显式重算后恢复 `CURRENT`，上一次有效结果在失败时仍保留并明确标为过期。

## 6. 证据等级

- 代码验证：已完成。
- 隔离测试数据验证：已完成。
- 真实环境验证：无。
- 尚未验证：真实交易量下的 FIFO 性能、真实费用分布、生产历史数据迁移后的实际盈亏结果。
