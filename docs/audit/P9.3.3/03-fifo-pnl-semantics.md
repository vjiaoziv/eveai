# 03 FIFO 盈亏、胜率与计算新鲜度

## 验证状态

- 已通过代码验证。
- 已通过隔离 SQLite 测试验证。
- 未用真实钱包和人工核实交易验证。

## 已实现盈亏口径

实现明确拆分：

- unknownConsumptionCount：已卖出但 FIFO 成本无法确定的消耗数。
- unknownOpenLotCount：尚未卖出且成本未知的开放批次数。
- unknownCostSellCount：至少包含一个 UNKNOWN 成本消耗的卖出笔数。
- deterministicSellCount：FIFO 成本完整、可进入确定性胜率的卖出笔数。

规则：

- realizedPnl 仅在 unknownConsumptionCount 等于 0 时为确定金额。
- 未售出 UNKNOWN 批次不会使已实现盈亏变为 N/A。
- knownRealizedPnl 保留所有已计算消耗的已知部分，但不冒充完整已实现盈亏。
- 单笔卖出只要跨到任一 UNKNOWN 批次，该笔 singleTradePnl 为 null，不进入确定性胜率。
- profitableTradeRatio 使用可确定卖出的盈利笔数除以 deterministicSellCount。
- 未售出 UNKNOWN 仍会使 inventoryCost、capitalOccupied 和未实现盈亏保持 N/A，不会伪装为确定数值。

## 测试覆盖

- 已知成本 A 完成买卖，另有未售出 UNKNOWN B：已实现盈亏和胜率可计算；库存成本与资金占用为 N/A。
- 确定卖出加 UNKNOWN_SOURCE 卖出：完整 realizedPnl 为 N/A，knownRealizedPnl 仍可展示，未知成本卖出笔数准确。
- 只有未售出 UNKNOWN、所有已完成卖出成本已知：胜率仍可计算。
- 单笔卖出跨已知和未知批次：该笔不进入确定性胜率。
- 重复 FIFO 重算：结果哈希稳定，数量、成本、盈亏无无依据变化。

## 计算新鲜度

新增 P93CalculationFreshness：

- CURRENT；
- STALE；
- NEVER_CALCULATED。

判定输入：

- 最近一次成功计算时间；
- 最近一次失败计算时间；
- 最近一条已核实 REAL 账本事实或证据状态事件时间。

出现以下情况时标记 STALE：

- 最新 REAL 账本事实或证据状态事件晚于最近一次成功计算；
- 最近一次重算失败晚于最近一次成功计算。

重算成功后才恢复 CURRENT。计算失败不会删除上一次有效派生结果，但前端必须显示过期警告。当前不自动频繁重算。

## 前端

P9.3 会计面板展示：

- 计算状态；
- 确定性已实现盈亏；
- 已知部分盈亏；
- CURRENT 以外状态的可访问警告文本。

## 业务边界

ESI wallet transactions 不提供完整经纪人费和税费，钱包同步记录保持 feeStatus = UNKNOWN。方向、数量和成交价确定并不自动代表完整费用口径已确定。
