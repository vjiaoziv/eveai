# 03. FIFO 与盈亏计算

## 审计范围

- `src/trading/p9-3-fifo-service.ts`
- `src/trading/p9-3-ledger-service.ts`
- `tests/unit/p9-3.3-fifo.test.ts`
- `tests/unit/p9-3.3.1-audit-freshness.test.ts`
- `web/src/components/P93AccountingPanel.tsx`
- `web/src/components/P9TradingScreen.tsx`
- `src/web/p9-routes.ts`

## 已通过代码验证的口径

### 已实现盈亏

`P93FifoService.performance()` 将两类未知成本分开：

- `unknownConsumptionCount`：已售出消耗中 `pnl_status = UNKNOWN_COST` 的数量。
- `unknownOpenLotCount`：未售出且 `cost_status <> KNOWN` 的开放批次数量。

关键代码：`src/trading/p9-3-fifo-service.ts:503-516`。

```text
realizedPnl =
  unknownConsumptionCount > 0
    ? null
    : roundMoney(known_pnl)
```

因此：

- 已售数量成本完整时，已实现盈亏可计算。
- 未售出 UNKNOWN 批次只影响 `inventoryCost`、`capitalOccupied` 和未实现估值。
- `knownRealizedPnl` 始终保留已知部分的可见值，但不会被冒充为完整已实现盈亏。
- `unknownConsumptionCount + unknownOpenLotCount` 仍作为总未知成本项数量展示。

### 胜率

胜率按 sell record 聚合并只使用可确定卖出：

- 单个卖出记录任一 FIFO 消耗批次未知，则该卖出 `pnl = NULL`。
- `deterministicSellCount` 只统计可确定卖出。
- `unknownCostSellCount` 单独统计未知成本卖出。
- `profitableTradeRatio = profitable / deterministic`；确定性卖出为 0 时为 `null`。

关键代码：`:518-538`。

### 库存成本和资金占用

- 任一开放 UNKNOWN 批次存在时，`inventoryCost = null`。
- 任一开放 UNKNOWN 批次存在时，`capitalOccupied = null`。
- 不会把已知部分成本伪装成完整库存成本。

关键代码：`:593-594`、`:610-680`。

## 已通过隔离测试验证的必需场景

| 必需场景 | 实际测试 | 结果 |
|---|---|---|
| A：已知 A 已卖，另有未售 UNKNOWN B | `p9-3.3-fifo.test.ts:82-109`；已实现盈亏 50、胜率 1、库存成本 null、资金占用 null | 通过 |
| B：一笔确定卖出 + 一笔 UNKNOWN_SOURCE 卖出 | `p9-3.3-fifo.test.ts:111-140`；完整 realizedPnl null，knownRealizedPnl 50，未知卖出 1 | 通过 |
| C：未售 UNKNOWN 库存不污染胜率 | 同 A 测试 `:82-109`；胜率仍为 1 | 通过 |
| D：一笔卖出跨已知/未知批次 | `p9-3.3-fifo.test.ts:142-166`；胜率 null，未知卖出 1，singleTradePnl null | 通过 |
| E：重复 FIFO 重算哈希稳定 | `p9-3.3-fifo.test.ts:168-189` | 通过 |
| 证据状态变化使旧结果 STALE | `p9-3.3-fifo.test.ts:191-212` | 通过 |
| 最近一次重算失败保留旧值但标记 STALE | `p9-3.3-fifo.test.ts:213-232` | 通过 |
| 核实、冲正、更正后 STALE，重算后 CURRENT | 独立审计 `p9-3.3.1-audit-freshness.test.ts:72-106` | 通过 |

## Freshness 源码复核

`calculationFreshness()`：

- 无成功计算：`NEVER_CALCULATED`
- 最新已核实/冲正/更正账本事件晚于成功计算：`STALE`
- 最近尝试失败且晚于最近成功计算：`STALE`
- 否则：`CURRENT`

位置：`src/trading/p9-3-fifo-service.ts:80-140`。

`performance()` 在返回结果中包含 `freshness`：`:585-607`。

## 已确认缺陷

### F-06（P2）部分 REAL 盈亏页面未展示 freshness

#### 问题 1：P9.3 账本页只有总览展示警告

- 总览页显示 `计算状态` 和 freshness 警告：`web/src/components/P93AccountingPanel.tsx:244-260`。
- `pnl` 页直接显示已实现盈亏、未实现盈亏、费用等指标：`:426-445`。
- 该页没有 freshness 字段或 STALE/NEVER_CALCULATED 警告。

影响：用户切到“盈亏分析”后可能把旧结果视为当前结果。

#### 问题 2：兼容 overview API 不返回 freshness

- `src/web/p9-routes.ts:199-247` 调用 `P93FifoService.performance()`。
- 返回值只映射 `realizedNetPnl`、`knownRealizedPnl`、`feesPaid`、`unrealizedPnl`、`tradeCount`、`profitableTradeRatio`、`averageHoldingDays`。
- 没有传递 `accounting.freshness`。

#### 问题 3：P9 Trading 页面展示 REAL 盈亏但无 freshness 警告

- 总览：`web/src/components/P9TradingScreen.tsx:320-322`
- 性能页：`:533-544`
- 页面显示 `已实现净盈亏`、`未实现盈亏` 和收益排名，但没有 FIFO freshness 状态。

影响：旧 FIFO 结果可能被用户当成当前完整核算，违反“STALE 不得显示为 CURRENT”的审计要求。定级 P2。

修复建议：

- 在兼容 overview API 中返回 `performance.freshness`。
- 统一所有展示 REAL 已实现/未实现盈亏、胜率、库存成本的组件，在非 `CURRENT` 时显示醒目警告。
- 可将 `NEVER_CALCULATED` 与 `STALE` 区分展示，并禁用“当前完整结果”措辞。
- 不要求自动频繁重算；保持用户显式重算流程。

## 测试覆盖缺口

- 费用修改后的 freshness 变 STALE：源码路径存在，但本轮未找到专门的独立费用修改测试；只覆盖核实、冲正、更正、证据状态变化和失败重算。
- 前端实际浏览器渲染和可访问性未验证。
- 真实资产估值数据、真实市场数据对未实现盈亏的影响未验证。

## 验证边界

- 已通过代码验证：UNKNOWN 消耗和 UNKNOWN 开放批次已分离；胜率按卖出记录聚合；freshness 判定路径存在。
- 已通过隔离 SQLite 测试：必需 A-E 场景、证据状态变化、失败重算、核实/冲正/更正。
- 已通过真实环境验证：无。
- 尚未验证：真实市场估值、真实浏览器 UI、费用修改专项。