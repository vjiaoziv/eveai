# EVEAI P8.5.2：回测系统与反未来数据泄漏审计报告 (P8_5_2_BACKTEST_AUDIT.md)

**完成日期**: 2026-11-02  
**关联代码**: `src/trading/backtesting/engine.ts`

---

## 一、三类回测模式与因果严密性

根据任务书规范，系统明确分离：
1. **日线信号研究回测 (`daily_signal_backtest`)**:
   - 输入: 历史每日收盘行情 (Highest, Lowest, Average, Volume)。
   - 时序因果: Day T 收盘计算均线 $\to$ Day T+1 挂单买入 $\to$ Day T+2 挂单平仓。
   - 标注: 明确将次日均价标为 `post_hoc_average_price_assumption`，将 1.5% 标为 `simplified_1.5pct_friction`。
2. **历史订单簿执行回测 (`executable_orderbook_backtest`)**:
   - 规则: 仅在具备历史逐笔 L2 订单簿切片时才允许启动。当前本地环境未收录按秒记录的历史订单簿，系统**硬性禁用该模式**，禁止伪造历史深度。

---

## 二、量化风险指标核验

- **Sortino Ratio**:
  下行偏差仅统计 $R_i < 0$ 的负向波动，未形成连续日历净值前输出真实下行风险比率。
- **95% CVaR**:
  引入样本量阈值门禁（$N \ge 20$），样本不足时强制输出 `cvar95Pct: null` 并提示“数据样本不足”，杜绝小样本统计失真。
