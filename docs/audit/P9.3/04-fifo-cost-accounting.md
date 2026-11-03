# P9.3 FIFO 成本核算报告

## 规则

1. 只有 VERIFIED REAL 买卖记录参与 FIFO。
2. 每笔买入生成独立成本批次，记录原始数量、剩余数量、基础成本、资本化费用、单位成本和剩余成本。
3. 卖出按 `character_id + type_id + location_id` 以 `acquired_at, lot_id` 先进先出。
4. 部分卖出逐批次消耗；多批次卖出形成多条 `real_fifo_consumptions`。
5. 库存不足时生成 `lot_id=UNKNOWN_SOURCE` 消耗行，不虚构历史成本。
6. UNKNOWN 或部分未知成本的消耗，`realized_pnl` 为 NULL，状态为 UNKNOWN_COST。

## 费用处理

- CAPITALIZED：计入库存批次成本。
- SELL_EXPENSE：按卖出数量比例分摊到 FIFO 消耗。
- PERIOD_EXPENSE：计入期间费用，不进入库存成本。
- UNRELATED：排除交易盈亏。
- UNKNOWN：不猜测，不按 0 处理。

## 计算版本

每次重算创建 `real_calculation_runs`，保存版本 `P9.3-FIFO-v1`、前后哈希、已知盈亏、未知成本数和前后差异。派生批次/消耗可以重建，但原始交易事件不被覆盖。

## 测试结果

单元测试覆盖单笔买卖、多买入一次卖出、一次买入多次卖出、部分成交、费用、UNKNOWN 成本、库存不足、冲正/更正和历史重算。