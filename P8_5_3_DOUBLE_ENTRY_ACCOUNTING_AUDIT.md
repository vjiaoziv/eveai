# EVEAI P8.5.3：双重记账流水与真实会计审计报告 (P8_5_3_DOUBLE_ENTRY_ACCOUNTING_AUDIT.md)

**完成日期**: 2026-11-02  
**关联代码**: `src/trading/paper-trading.ts`

---

## 一、会计科目界定与借贷平衡方程

必须彻底厘清虚拟交易过程中的资产、负债、权益与损益流转，消除手续费重复扣除隐患：

### 1. 资产负债表与权益方程
$$\text{Total Virtual Assets} \equiv \text{Total Virtual Equity}$$
- **总资产 (Assets)**:
  $$\text{Assets} = \text{Available Cash (可用现金)} + \text{Escrow Locked (冻结保证金)} + \text{Inventory Cost Basis (库存成本原值)}$$
- **总权益 (Equity)**:
  $$\text{Equity} = \text{Initial Cash (初始投入)} + \text{Total Realized PnL (累计净实现盈亏)} - \text{Total Unused Fees}$$

### 2. 消除费用双重扣减的核心纠偏
- **原隐患**: 买单成交时误计入了卖方应缴纳的销售税；而在卖出结算时，`netRealizedPnl` 已经扣除了卖方税费，若在核验资产平衡时再次全额扣减 `total_fees_paid`，将导致卖方税费被重复扣减两次。
- **P8.5.3 严格解耦**:
  1. 买单撮合时：买方仅承担挂单买入经纪人费 (`buyerFee`)，记入实际采购成本与手续费支出，严禁计入销售税。
  2. 卖单撮合时：卖方承担销售税与卖方经纪人费 (`sellerFee`)，从销售回笼现金中直接扣除。
  3. 撤销买单时：全额释放未成交份额对应的保证金及未使用的保底费缓冲，确保可用资金与担保金完全守恒。

---

## 二、自动对账验证器 (`verifyAccountBalance`)

系统内置确定性对账函数：
```typescript
const expectedTotal = acc.initial_cash + acc.total_realized_pnl - acc.total_fees_paid;
const actualTotal = acc.available_cash + acc.escrow_locked + inventoryCostBasis;
const discrepancy = Math.round((actualTotal - expectedTotal) * 100) / 100;
```
- 在经历开仓、部分成交、连续撤单、止盈卖出等多轮极限并发操作后，实测断言：
  `isReconciled === true` 且 `discrepancy === 0.00 ISK`。
