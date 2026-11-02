# EVEAI P8.5.1：量化绩效指标统计口径核验报告 (P8_5_1_PERFORMANCE_METRICS_AUDIT.md)

**完成日期**: 2026-11-02  
**关联代码**: `src/trading/backtesting/engine.ts`, `src/trading/paper-trading.ts`

---

## 一、Sortino Ratio（索提诺比率）口径核验

### 1. 理论公式与年化依据
$$\text{Sortino} = \frac{\bar{R} - \text{MAR}}{\sigma_d} \times \sqrt{K}$$
- **MAR (最低可接受回报)**: 在 EVE 市场中设定为 0（无风险利率设为 0）。
- **$\sigma_d$ (下行偏差)**:
  $$\sigma_d = \sqrt{\frac{1}{N} \sum_{i=1}^{N} \min(0, R_i - \text{MAR})^2}$$
- **年化系数 $K$**:
  - 若输入数据为**日频账户净值收益率**，EVE 市场 365 天无休，理论日历天数为 365，金融对标取 252 交易日，取 $\sqrt{252}$。
  - 若输入为**逐笔不定期交易收益率 (Per-Trade)**，直接乘以 $\sqrt{252}$ 将夸大高频交易的夏普/索提诺比率。系统已重构为：在交易未形成连续日历净值序列前，输出**未年化下行收益比**（Unannualized Downside Ratio），避免误导。

---

## 二、95% CVaR（条件在险价值）与小样本保护

1. **VaR 与 CVaR 的区别**:
   - $95\%\text{ VaR}$: 在 95% 置信水平下，单笔交易的最大潜在亏损分位数（即最差 5% 的边界损失）。
   - $95\%\text{ CVaR}$ (Expected Shortfall): **超越该分位数后的所有极端尾部损失的算术平均值**。
2. **小样本截断规则**:
   当历史成交样本 $N < 20$ 时，最差 5% 的样本数量不足 1 笔。此时计算的 CVaR 毫无统计学意义。系统设定：**样本数量 $N < 20$ 时，强制输出 `cvar95Pct: null`（标注样本不足），严禁输出虚假数值**。

---

## 三、资金周转率 (Capital Turnover Rate) 口径

- 严禁将买卖两端简单加总冒充周转率。
- **准确口径**:
  $$\text{Capital Turnover Rate} = \frac{\sum_{j=1}^{M} \text{Actual Purchase Cost}_j}{\text{Initial Virtual Capital}}$$
  衡量的是初始本金被完整循环利用的周转倍数。
