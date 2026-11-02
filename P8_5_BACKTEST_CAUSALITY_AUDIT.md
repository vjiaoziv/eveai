# EVEAI P8.5：回测系统时间因果与反未来数据审计 (P8_5_BACKTEST_CAUSALITY_AUDIT.md)

**完成日期**: 2026-11-02  
**关联代码**: `src/trading/backtesting/engine.ts`

---

## 一、日线回测的时间因果律（Time-Causality）

### 1. 致命缺陷根除
P8 原逻辑中：在第 `i` 天判断均线指标后，直接设定 `entryPrice = current.average`（即第 `i` 天均价）。
- **时间旅行漏洞**: `current.average` 是第 `i` 天全天收盘结算后汇总生成的全天加权价。系统在尚未收盘前不可能预知全天均价。
- **因果倒置**: 当天收盘产生买入信号，买入动作却发生在当天，构成了典型的回测偷窥未来。

### 2. P8.5 严格的因果链重构
在 `BacktestingEngine.runHistoricalBacktest` 中实施严格的三日时序推进：
```text
Day T (信号生成日)     Day T+1 (挂单执行日)    Day T+2 (平仓出场日)
     │                      │                      │
     ▼                      ▼                      ▼
收盘计算 [T-14, T] 均线 ──> 以 T+1 日均价建仓 ────> 以 T+2 日均价扣滑点出场
```
- **信号计算**: 严格使用截至 Day T 收盘的日线窗口。
- **建仓执行**: 只能在 Day T+1 发生（`entryPrice = series[i+1].average`）。
- **平仓执行**: 只能在 Day T+2 发生（`exitPrice = series[i+2].average * (1 - slippageFriction)`）。
- 数据末端：若后续交易日不足 2 天，放弃开仓，杜绝截断偏差。

---

## 二、滑点假设与绩效指标透明化

1. **滑点模型客观定性**:
   由于历史日线数据不包含逐笔 L2 订单簿，系统将 1.5% 摩擦明确标注为 `simplified_1.5pct_friction`（简化滑点假设），回测类型明确标为 `daily_signal_backtest`，严禁冒充真实撮合。
2. **新增两大量化风控指标**:
   - **Sortino Ratio (索提诺比率)**:
     $$\text{Sortino} = \frac{\bar{R}}{\sqrt{\frac{1}{N}\sum \min(0, R_i)^2}} \times \sqrt{252}$$
     仅惩罚下行负收益波动，真实反映抗跌能力。
   - **95% CVaR (条件在险价值 / 预期亏损)**:
     统计历史最差 5% 交易的平均损失，刻画极端肥尾风险。

---

## 三、测试用例验证 (Case D)

在 `tests/unit/p8-5-integration.test.ts` 中构建 25 日合成价格序列进行检验：
- **测试结果 (PASS)**:
  对回测生成的每一笔交易断言：
  `signalDate < entryDate < exitDate`。
  严格证明无任何信号能够突破时间因果限制提前入场。
