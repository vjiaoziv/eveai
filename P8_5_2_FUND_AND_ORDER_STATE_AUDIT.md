# EVEAI P8.5.2：资金安全与订单状态机深度审计报告 (P8_5_2_FUND_AND_ORDER_STATE_AUDIT.md)

**完成日期**: 2026-11-02  
**关联代码**: `src/trading/paper-trading.ts`, `src/db/migrations.ts`

---

## 一、双重记账资金流水系统 (Double-Entry Journal)

为消除虚拟账户在并发与部分成交过程中的账目漂移，P8.5.2 引入了严格的资金流水账表 `paper_trading_journal`：
- 每次资金变动必须记录：
  `entry_type` (deposit, escrow_lock, escrow_release, order_spend, order_revenue, fee_payment)
  `amount`, `balance_after`, `escrow_after`。
- **自动对账验证器 (`verifyAccountBalance`)**:
  每一笔交易与撤单后，系统均执行资产负债表严格对账：
  $$\text{Total Virtual Assets} = \text{Available Cash} + \text{Escrow Locked} + \text{Inventory Cost Basis}$$
  $$\text{Total Equity} = \text{Initial Cash} + \text{Realized PnL} - \text{Total Fees Paid}$$
  断言 $\text{Discrepancy} < 0.05\text{ ISK}$。

---

## 二、订单状态机合法跃迁约束

P8.5.2 建立了状态机跃迁矩阵，严格封堵非法状态篡改：
```text
            ┌──────────────────┐
            │       open       │
            └─────────┬────────┘
                      │
         ┌────────────┼────────────┬─────────────┐
         ▼            ▼            ▼             ▼
┌─────────────────┐ ┌────────┐ ┌───────────┐ ┌─────────┐
│ partially_filled│ │ filled │ │ cancelled │ │ expired │
└────────┬────────┘ └────────┘ └───────────┘ └─────────┘
         │               ▲
         └───────────────┘
```
- **终端状态封死**: `filled`, `cancelled`, `expired` 为终结态，不允许任何后续更新。
- 任何试图将 `filled` 回退为 `open` 或将 `cancelled` 改为 `filled` 的操作直接抛出 `【状态机非法跳转】` 异常。

---

## 三、并发与幂等性测试验证

1. **100 并发抢夺有限资金 (Scenario A)**:
   100 笔各需 20 万的订单争抢 1,000 万可用资金，最终 48 笔成功创建，剩余 52 笔被事务安全拦截，可用资金精确截断于 $\ge 0$，无资金穿透。
2. **幂等性 100 次重复调用 (Scenario B)**:
   携带同一 `idempotency_key` 连续调用 100 次，返回相同 `orderId`，数据库中严格仅落盘 1 笔订单，避免网络重试导致的重复扣款。
