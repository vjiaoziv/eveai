# EVEAI P8.5.4：复式记账模型与资金安全审计报告 (05-accounting-model-audit.md)

**完成日期**: 2026-11-02  
**关联代码**: `src/trading/paper-trading.ts`

---

## 一、复式记账借贷平衡方程

P8.5.4 建立了标准的复式记账核验模型：
$$\text{Total Virtual Assets} \equiv \text{Total Virtual Equity}$$
- **总资产**: 可用现金 (`available_cash`) + 冻结资金 (`escrow_locked`) + 模拟库存成本原值 (`inventoryCostBasis`)。
- **总权益**: 初始虚拟注入本金 (`initial_cash`) + 累计净实现利润 (`total_realized_pnl`) - 累计交易手续费 (`total_fees_paid`)。

---

## 二、消除费用双重扣减的核心审计结论

P8.5.3 彻底修复了原先买单成交时误计入卖方销售税的漏洞：
1. **买单成交**: 仅扣除买方挂单经纪人费 (`buyerFee`)，记入采购支出；绝不计入卖方销售税。
2. **卖单成交**: 从销售毛收入中直接扣减销售税与卖方经纪人费，以净变现金额回流现金池。
3. **部分成交后撤单**: 精确释放未成交数量对应的冻结保证金及多余保底缓冲。
- **实测审计结果**: 在 `tests/unit/p8-5-2-stress.test.ts` 与 `p8-5-1-paper-trading.test.ts` 中连续执行多轮并发开仓、撮合、撤单操作，`verifyAccountBalance` 断言误差恒定为 **0.00 ISK**。
