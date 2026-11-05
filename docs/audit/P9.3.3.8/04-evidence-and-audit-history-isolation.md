# 04 证据和审计历史隔离

## 1. 证据类型和关联

P9.3.3.8 将以下对象视为 REAL 账本审计面的一部分：

- `real_trade_evidence` 及其与记录的关联；
- `real_trade_events`；
- `real_trade_fees`；
- `real_fifo_lots` 和 `real_fifo_consumptions`；
- `real_calculation_runs`；
- `real_reconciliation_runs` 和 cases；
- 控制面 opportunity/plan/job audit history。

这些对象即使不是“交易事实”本身，也可能泄露成本、盈亏、对手、来源或操作历史，因此必须使用同一 owner/chat/epoch 条件。

## 2. 证据写入

钱包同步使用稳定来源：

```text
source_ref = esi-wallet:<transaction_id>
```

证据 payload 经过严格标准化后计算 SHA-256。幂等设计同时限制：

- 同一 `ledgerKey` 不重复创建交易；
- 同一来源引用不重复生成证据；
- 已有证据关联不重复插入；
- 重试只更新可重试状态，不覆盖人工核实后的事实。

证据的 `capturedAt`、`sourceRef`、metadata 和 hash 与目标角色一致。同步服务不把 ESI 钱包日志直接当作“已人工核实交易”。

## 3. 读取隔离

审计事件的查询以记录 ID 和 lineage 同时作为条件；只按 record_id 查询会在命中旧 owner 记录时泄露事件。对账历史和 AI 输入也分别在子查询层面过滤，避免用当前 owner 的汇总去“稀释”其他 owner 的事实。

跨 owner 测试要求：

- detail 返回空/404；
- list 不出现旧 record_id；
- evidence 不出现旧 payload/hash；
- event 不出现旧 actor/reason；
- FIFO 和 reconciliation 不出现旧 lot/run；
- AI prompt 不包含旧标记文本。

## 4. 审计历史保留

同一 owner/lane/epoch 内的 scope refresh 只改变 `binding_digest` 时，历史仍可见。该决定避免把 OAuth scope 的正常变化误判为所有权变化，同时保持 owner/chat/epoch 真正的持久授权边界。

如果所有权或 epoch 真正变化，旧历史不自动转移。legacy ownerless 历史保留为审计证据，但不暴露给新 owner。

## 5. 幂等和不可覆盖

- 证据来源引用是幂等键。
- 同一批次重复同步不会重复创建证据或关联。
- 已核实事实不可原位覆盖；更正/冲正通过新事实和事件记录。
- 财务触发器禁止删除交易事实、禁止未授权覆盖非草稿事实。
- 同步失败可以重试，但不得把失败记录静默当成成功。

## 6. 验证

- `tests/unit/p9-3.3-evidence.test.ts` 覆盖严格字段、固定角色、缺 scope、分页、失败重试和证据幂等。
- `tests/audit/p9-3.3.8/real-ledger-ownership-isolation.test.ts` 覆盖旧 owner 证据/事件隐藏。
- `tests/audit/p9-3.3.8/reconciliation-ownership.test.ts` 覆盖对账和 AI payload 隔离。

## 7. 残余风险

旧 ownerless 证据的真实历史关系无法由当前绑定自动证明。若必须恢复，应由人工 reconciliation 检查原始来源、时间和外部证据，并把处理决定写入审计记录。该流程尚未在本阶段实现为 UI 工作流。
