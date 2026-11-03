# P9.3 交易账本设计报告

## 主表

`real_trade_records` 保存 REAL 交易事实和状态：

- `ledger_key` + `character_id` 唯一，阻止重复登记。
- `source_hash` 对交易事实做幂等校验；相同 key 不同事实直接拒绝。
- `record_state`：DRAFT、ACTIVE、VERIFIED、REJECTED、REVERSED、CORRECTED。
- `verification_status`：VERIFIED、USER_REPORTED、PENDING、CONFLICT、REJECTED。
- `trade_kind` 覆盖买入、卖出、部分成交、多批次成交、费用调整、成本调整、库存转移和冲正。
- `fee_status` 区分费用完整与 UNKNOWN。
- `is_paper` 强制为 0，REAL/PAPER 隔离在数据库层执行。

## 不可变性

- 已核实、已冲正、已更正记录不能直接删除。
- 非草稿记录的数量、价格、时间、来源和 PAPER 标记不能原地覆盖。
- 修改草稿、核实、驳回、冲正和更正均写入 `real_trade_events`。
- 财务事件日志只能追加；已核实证据不能覆盖或删除。

## 流程

- 人工录入 → 草稿/用户申报 → 关联证据 → 人工核实 → FIFO。
- 错误记录使用 `correction` 创建新草稿并把原记录标记 CORRECTED；不可静默改写。
- 无效记录使用 `reverse` 冲正；原始事件保留。

## 限制

- 目前费用通过显式费用行建模；ESI wallet transactions 本身不提供完整经纪人费/税费，因此同步记录费用完整性为 UNKNOWN。
- 库存转移已入账，但当前 FIFO 重点核算买卖批次；跨地点转移的数量移动仍需在后续版本完善批次拆分。