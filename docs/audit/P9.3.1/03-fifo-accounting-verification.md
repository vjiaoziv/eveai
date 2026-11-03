# FIFO 核算验证报告

## 1. 代码口径

**已通过代码验证**

- 只有 VERIFIED + VERIFIED + `is_paper = 0` 的真实交易进入重算。
- 每笔 VERIFIED BUY 建立独立 lot。
- 卖出按 `acquired_at, lot_id` FIFO 消耗同角色、同物品、同地点批次。
- 部分卖出保留剩余批次和剩余成本。
- 库存不足生成 `UNKNOWN_SOURCE` consumption，不伪造成本。
- UNKNOWN/PARTIAL 成本批次不进入确定已实现盈亏。
- 已核实 INVENTORY_TRANSFER 可在同地点间移动和拆分 FIFO 批次。
- 冲正/更正通过状态变化触发全量重建，不删除原始交易历史。
- `real_fifo_consumptions` 对 `(sell_record_id, lot_id)` 唯一，禁止重复扣减。
- 核算运行保存 before/after hash；稳定业务字段未变化时重复重算 hash 一致。

## 2. 修复前的风险与修复

**已通过代码验证**

- 原 unit cost 过早按分取整，重复小数会产生成本丢失；现保留 8 位单位成本，并让最终批次吸收金额余差。
- 原卖出费用逐批四舍五入可能丢失/重复 0.01 ISK；现最终批次吸收费用余差。
- 原未实现盈亏可能把最新估值和另一快照的 item_id 混用；现估值严格绑定最新完整快照。
- 原库存转移未进入 FIFO；现已支持经过人工核实的同物品转移。
- 原盈利交易比例按 consumption 数除卖出数，可能大于 100%；现按卖出记录聚合并封顶为有效比例逻辑。

## 3. 隔离测试验证

**已通过隔离测试数据验证**

- 多买入 + 一次卖出 FIFO：通过。
- 一条买入 + 多次部分卖出：通过。
- 资本化费用和卖出费用：通过。
- 费用尾差分配到 0.01 ISK 精度：通过。
- 100/3 重复小数成本完整卖出：实现盈亏为精确 50，通过。
- UNKNOWN 成本、库存不足、UNKNOWN_SOURCE：不进入确定盈亏，通过。
- 部分库存转移后分地点 FIFO 消耗：通过。
- 冲正后历史重算恢复库存和已实现盈亏：通过。
- 重复重算稳定 hash：通过。
- 唯一消耗索引和费用/证据关系不可变触发器：通过。

## 4. 真实环境验证

**已通过真实环境验证**

生产库在没有任何真实交易样本的前提下执行了一次不伪造交易的派生重算：

- calculation run：`CALC-24fe8ce6-9fd8-426b-a8c2-5ff921b5110b`
- status：`COMPLETED`
- record_count：0
- realized_pnl：0
- unknown_cost_count：0
- before_hash = after_hash：`1356a9f1...303c2e0`
- `real_trade_records` / `real_trade_events` / `real_trade_evidence` 执行前后均为 0
- `ledgerUnchanged = true`

这验证了真实生产库上的零状态重算和安全落盘，但**不等于**真实交易 FIFO 已验证。

## 5. 结论

- FIFO 代码与约束：**已通过代码验证**。
- FIFO 计算、部分卖出、费用、UNKNOWN、转移、冲正重算：**已通过隔离测试数据验证**。
- 生产库零交易派生重算：**已通过真实环境验证**。
- 真实交易 FIFO 闭环：**尚未验证**。