# P9.3 资产对账报告

## 对账对象

- P9.3 FIFO 当前剩余库存（按 type_id/location_id）。
- P9.2 最新 COMPLETE ESI 资产快照（按 type_id/location_id）。
- 最新估值价值（仅作 VALUE_MISMATCH 辅助，不把估值当成本）。

## 状态

- MATCHED：数量一致且成本已知。
- UNMATCHED：账本有库存但资产快照没有。
- PARTIAL_MATCH：部分匹配。
- QUANTITY_MISMATCH：数量不一致。
- VALUE_MISMATCH：数量一致但成本未知/不一致。
- UNKNOWN_SOURCE：资产有数量但账本无来源。
- RECONCILIATION_REQUIRED：需要人工处理。

## 自动化边界

资产变化只创建 `real_reconciliation_cases` 人工复核案例。任务奖励、NPC 掉落、合同、制造、再处理、装配、转移不会被自动归类为买卖。

重复来源引用也会创建 `DUPLICATE_SOURCE_REFERENCE` 案例。最终对账结果保存在 `real_reconciliation_runs/items/cases`。

## 测试

内存测试验证了账本与快照数量一致时 MATCHED，资产多出来源不明物品时 UNKNOWN_SOURCE，并确认资产变化不会增加真实交易记录。