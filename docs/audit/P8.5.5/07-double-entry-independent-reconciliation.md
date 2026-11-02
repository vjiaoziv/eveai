# P8.5.5 独立复式记账重算

## 修复前问题

verifyAccountBalance 只能证明期末恒等式：

~~~text
Cash + Escrow + Inventory Cost Basis == Initial Cash + Realized PnL - Fees Paid
~~~

它不能证明逐笔 journal 可重建，也不能暴露费用漏记。原实现中：

- 买单成交的 buyerFee 与 order_spend 一起从 escrow 扣除，但 journal.order_spend 只记录 actualSpend。
- 卖单 order_revenue 记录 netRev，卖方费用没有独立分录。
- 部分成交撤单只退未成交货值，可能残留未使用费用缓冲。

## 修复

src/trading/paper-trading.ts:200-508：

- paper_trading_orders 新增 escrow_locked 和 fee_reserved。
- createVirtualOrder 记录完整初始担保金和费用预留。
- 买单成交拆分为 order_spend 和 fee_payment。
- 卖单成交拆分为 gross order_revenue 和 fee_payment。
- cancelVirtualOrder 按订单剩余 escrow_locked 精确退款，不再只退未成交货值。
- 订单取消后 escrow_locked 与 fee_reserved 归零。

## 独立重算

tests/unit/p8-5-5-independent-ledger.test.ts:16-65 不调用 verifyAccountBalance，而是：

1. 按 journal_id 顺序读取 paper_trading_journal。
2. 根据 entry_type 重算 cash 与 escrow。
3. fee_payment 根据订单是买/卖决定从 escrow 或 cash 扣除。
4. 每条分录后对比 balance_after 与 escrow_after。
5. 独立读取 paper_trading_positions 计算 inventory cost basis。
6. 独立汇总 fee_payment。

场景：

~~~text
initial cash       1,000,000
buy order escrow     102,100
partial fill spend    30,000
buyer fee                630
cancel refund         71,470
final cash           969,370
inventory cost        30,000
total fees               630
assets               999,370
expected equity      999,370
difference                 0
~~~

测试位置：tests/unit/p8-5-5-independent-ledger.test.ts:69，结果 1/1 通过。

## 精度与历史数据

- 当前使用 JS number，并把凭证金额限制为两位小数。
- journal 金额仍使用 REAL，整数分单位或 Decimal/BigInt 尚未实现。
- 新迁移只给 paper_trading_orders 新增列，没有为历史订单重算 escrow_locked；历史遗留数据可能无法精确重建。
- realized_pnl journal 类型存在但当前成交路径通过账户累计值和 fee_payment 体现，未写 realized_pnl 分录。

## 结论

当前新建模拟交易的逐笔 journal 可独立重建，部分成交撤单的担保金释放已修复。历史订单数据迁移和任意精度账本仍未完成，因此复式记账结论为当前路径 PASS、历史迁移 PARTIAL。
