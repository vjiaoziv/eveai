# EVEAI 策略历史回测与模拟交易指南
**文档编号**：`BACKTESTING_GUIDE.md`  
**基准日期**：2026-11-02  
**代码对应**：`src/trading/backtesting/engine.ts`, `src/trading/paper-trading.ts`

---

## 一、历史回测系统核心机制 (Backtesting Engine)

### 1. 严格杜绝“未来数据泄漏” (No Lookahead Bias)
回测引擎严格按历史日历时间步长推进：
- 在评估历史第 $T$ 天的买入信号时，系统仅允许访问 $T$ 天及之前的历史数据（如 MA14、历史最低价、当日成交量）；
- 严禁在第 $T$ 天调用第 $T+1$ 天的收盘价或最低价做决策；
- 退出模拟按预设持有天数（如次日出局或达到均线离场）执行。

### 2. 回测核心量化指标
回测引擎执行完毕后输出标准量化绩效报告：
- **总收益率 (Total ROI %)**：$(Capital_{final} - Capital_{initial}) / Capital_{initial} \times 100\%$；
- **最大回撤 (Max Drawdown %)**：资金净值曲线从最高峰值到最低波谷的最大回撤幅度；
- **胜率 (Win Rate %)**：盈利交易笔数 / 总交易笔数；
- **盈亏比 (Profit Factor)**：总盈利金额 / 总亏损金额绝对值；
- **夏普比率 (Sharpe Ratio)**：以日对数收益率超额回报均值除以年化波动率（假定无风险利率为 0）；
- **手续费拖累占比 (Fee Drag %)**：缴纳的交易税费总额占总实现毛利润的比例。

---

## 二、模拟交易系统 (Paper Trading)

模拟盘用于在不消耗任何真实 ISK、不持有任何真实游戏物品的情况下，实时跟踪策略在真实订单簿中的虚拟表现：

1. **虚拟开仓 (`openPosition`)**：
   - 记录虚拟开仓价格、数量、时间及虚拟仓位编号（`PT-YYYYMMDD-NNN`）；
   - 数据独立存储于 `paper_trading_positions`，与角色真实资产 100% 物理隔离。
2. **每日盯市与公允估值 (Mark-to-Market)**：
   - 根据当前实时市场买单深度计算虚拟持仓的未实现浮动盈亏（Unrealized P&L）。
3. **虚拟平仓 (`closePosition`)**：
   - 模拟在当前市场以实际买单价卖出，扣除 5.36% 虚拟销售税后核算最终已实现盈亏（Realized P&L）。
