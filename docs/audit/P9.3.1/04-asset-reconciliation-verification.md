# 资产对账验证报告

## 1. 真实资产数据

**已通过真实环境验证**

生产库最新完整资产快照：

- `snapshot_id`: `ASSETSNAP-1793694005368-cec3e526`
- `character_id`: `2124784765`
- status: `COMPLETED`
- completed_at: `2026-11-03T08:20:05.368Z`
- total_items: 483
- total_unique_types: 366
- total_locations: 18
- total_quantity: 176090

对应最新估值：

- `valuation_id`: `ASSETVAL-1793694160630-ddaddae0`
- status: `COMPLETED`
- items_valued: 336
- items_unknown: 43

资产同步任务记录显示多个 COMPLETED 作业，最新作业 `ASSETJOB-1793704501965-76fc42c3` 完成，483 items fetched。相同 hash 被去重，因此 items_committed 为 0 是快照无变化的正常结果。

## 2. 对账代码与修复

**已通过代码验证**

- 对账只比较最新完整资产快照和 P9.3 FIFO 库存。
- 资产增加、资产减少、任务奖励、掉落、合同、制造等变化只生成人工复核案例，不自动生成交易。
- 数量一致且成本未知时返回需要人工复核的状态，不伪造成本。
- 估值必须属于当前对账快照。
- 重复来源检测排除 REJECTED/REVERSED/CORRECTED。
- 资产变化/重复来源产生的未结案例会阻止对账组错误标记 MATCHED。

## 3. 隔离测试验证

**已通过隔离测试数据验证**

- 账本库存与快照数量一致：MATCHED。
- 快照有库存、账本无来源：UNKNOWN_SOURCE。
- 资产变化不会增加真实交易记录。
- 两个活动记录共享 source_ref：生成 DUPLICATE_SOURCE_REFERENCE，即使数量项匹配，组状态仍为 RECONCILIATION_REQUIRED。
- 最新快照没有估值时不会复用旧快照估值，未实现值为 N/A_NO_VALUATION。

## 4. 真实环境对账执行

**已通过真实环境验证**

生产库执行结果：

- reconciliation run：`RECON-8a50f5be-f4db-4d52-9cec-49836adc3c8d`
- status：`RECONCILIATION_REQUIRED`
- item count：406
- status counts：`UNKNOWN_SOURCE = 406`
- duplicateSourceReferences：0
- assetChangeReviewCases：0
- 真实交易记录：执行前后均为 0
- `ledgerUnchanged = true`

这是正确的零账本结果：真实资产存在，但 P9.3 没有任何已核实真实交易来源，因此 406 个聚合物品/地点键全部需要人工解释。不得将 406 个差异项误读为 406 笔买入或交易错误。

## 5. 结论

- 对账代码和财务边界：**已通过代码验证**。
- MATCHED、UNKNOWN_SOURCE、重复来源和快照绑定：**已通过隔离测试数据验证**。
- 真实资产快照、估值和零账本对账：**已通过真实环境验证**。
- 有真实交易样本的完整账实一致/差异解释：**尚未验证**。