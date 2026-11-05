# EVEAI P8：模拟盘与实盘反馈闭环指南 (P8_PAPER_TRADING_GUIDE.md)

**完成日期**: 2026-11-02  
**关联代码**: `src/trading/paper-trading.ts`, `src/trading/draft-system.ts`

---

## 一、模拟盘 (Paper Trading) 与实盘严格隔离

1. **账户隔离**:
   - 模拟盘持仓记录于 `paper_trading_positions` 表中。
   - 实盘草案与执行台账分别记录于 `trade_drafts` 与 `trade_ledger`。
   - 严禁将模拟盘盈利与实盘钱包余额混同汇报。
2. **模拟盘撮合规则**:
   - 模拟买入严格扣减模拟现金，并按 `OrderBookSimulator.simulateBuy` 记录加权买入成本与税费。
   - 模拟卖出支持持仓时间、每日行情变动与真实多档位撮合。

---

## 二、人工实盘交易反馈闭环（Human-in-the-loop Execution）

当玩家在 EVE 客户端内手动完成了一笔基于 Agent 建议的交易后，通过命令行或 Web 面板回传实际执行结果：

### 1. 录入实际交易命令
```bash
npx tsx scripts/eve-cli.ts record-trade \
  --draft-id TR-2026-000002 \
  --buy-price 275000 \
  --sell-price 310000 \
  --qty 10 \
  --fees 15500 \
  --notes "Jita 4-4 手动购入，运至 Dodixie 挂卖单出货完成"
```

### 2. 差异对比与算法自检
系统自动比较：
- **预测买价 vs 实际买价**（检验采购端滑点预测准确度）
- **预测税费 vs 实际税费**（检验会计学与经纪人关系计算精度）
- **预测周期 vs 实际耗时**（检验物流跳数与出货周期模型）
- 差异自动归档至 `trade_ledger`，为后续策略参数调优提供无污染的第一手真实数据。
