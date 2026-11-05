# 06 FIFO、盈亏与新鲜度

## 1. UNKNOWN 成本拆分

src/trading/p9-3-fifo-service.ts:503-516 分别统计：

- unknownConsumptionCount：已卖出但成本未知的消耗记录；
- unknownOpenLotCount：仍持有且成本未知的批次；
- known_pnl：已知成本消耗产生的可确定部分。

完整已实现盈亏规则：

~~~text
unknownConsumptionCount > 0 ? null : known_pnl
~~~

因此未售出的 UNKNOWN 库存不会再把已实现盈亏错误变为 N/A。

## 2. 胜率口径

src/trading/p9-3-fifo-service.ts:518-538 按 sell_record_id 聚合：

- 一笔卖出只要有任一 consumption 为 UNKNOWN_COST，整笔卖出不进入确定性胜率；
- 只有全部 FIFO 批次成本可确定的卖出才计入 deterministicSellCount；
- unknownCostSellCount 单独统计；
- deterministicSellCount 为 0 时胜率为 null，不伪造 0%。

## 3. 库存成本与资金占用

src/trading/p9-3-fifo-service.ts:590-607、610-664：

- unknownOpenLotCount > 0 时 inventoryCost 和 capitalOccupied 为 null；
- 未实现盈亏在缺估值、数量不匹配或开放 UNKNOWN 成本时为 null；
- 不把 UNKNOWN 替换为 0；
- 部分 knownRealizedPnl 仍保留展示，但完整 realizedPnl 可为 null。

## 4. 测试覆盖

tests/unit/p9-3.3-fifo.test.ts 已覆盖：

- 仅开放 UNKNOWN 库存时，已实现盈亏与胜率仍可计算；
- 已售 UNKNOWN 成本使完整已实现盈亏 N/A，但 knownRealizedPnl 保留；
- 跨 known/unknown 多批次卖出不进入确定性胜率；
- unknownCostSellCount 精确统计；
- 混合 known/unknown 重复重算的 result hash 稳定；
- 失败重算后保留上一有效结果并标记 STALE。

## 5. 新鲜度

src/trading/p9-3-fifo-service.ts:63-139 计算：

- NEVER_CALCULATED：无成功计算；
- STALE：账本事实/事件晚于最近成功计算；
- STALE：最近一次重算失败；
- CURRENT：成功计算晚于当前事实且无更新失败。

账本事实来源包括 real_trade_events 与 real_trade_records.updated_at，筛选 REAL 且状态为 VERIFIED/REVERSED/CORRECTED，覆盖新增核实、冲正、更正、费用与证据状态事件。

## 6. 接口与页面覆盖

专项测试验证：

- compatible overview 保留 freshness 和 null 财务值；
- ledger 与 AI consumer 不把 STALE 展示为当前完整结果；
- 前端通过 web/src/p93-freshness.ts 统一映射状态；
- NEVER_CALCULATED、CURRENT、STALE 均可达。

## 7. 结论

在隔离测试范围内，FIFO UNKNOWN 口径和 freshness 修复有效。

尚未验证：

- 真实 FIFO 批次；
- 真实费用补录；
- 真实人工核实后的重算；
- 生产数据规模下的耗时与中断恢复。
