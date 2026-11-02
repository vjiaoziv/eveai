# EVEAI P8.5.4：逐笔账本与流水对账核验报告 (07-ledger-reconciliation.md)

**完成日期**: 2026-11-02  
**关联代码**: `src/trading/paper-trading.ts`

---

## 一、双重记账流水审计 (`paper_trading_journal`)

系统在 `paper_trading_journal` 表中对虚拟资金流动实施逐笔流水存证：
- **存证字段**: `journal_id`, `account_id`, `order_id`, `entry_type`, `amount`, `balance_after`, `escrow_after`, `created_at`。
- **业务流水覆盖**:
  - `deposit`: 初始虚拟本金注入；
  - `escrow_lock`: 挂单买入时的保证金冻结；
  - `escrow_release`: 撤销买单时的保证金全额释放；
  - `order_spend`: 买单成交时的采购金额与经纪人费划扣；
  - `order_revenue`: 卖单成交时的净变现现金回流。

---

## 二、逐笔借贷平衡对账断言

在 `tests/unit/p8-5-2-stress.test.ts` (Scenario L) 中执行高强度对账测试：
1. 初始存入 10,000,000 ISK $\to$ `verifyAccountBalance` 误差 0.00 ISK；
2. 提交 1,000 件买单挂单 $\to$ 资金转入 Escrow，总资产守恒；
3. 部分成交 500 件 $\to$ 生成持仓，扣除买方经纪人费，总权益与总资产完全平衡；
4. 撤单剩余 500 件 $\to$ 保证金精准释放，系统自动调用 `verifyAccountBalance`，误差恒为 **0.00 ISK**。
