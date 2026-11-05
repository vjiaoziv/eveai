# 05 冲正与更正安全

## 1. 目标

冲正和更正可能改变财务事实，是本阶段最高风险的写入路径。修复后的约束是：只有当前 owner/lane/epoch 的人工用户可以对当前可见记录发起；原事实不得删除或原位篡改；每次动作必须留下独立事件和来源链路。

## 2. 状态转换

允许的业务路径包括：

- `DRAFT -> VERIFIED`
- `PENDING/ACTIVE -> VERIFIED`（由人工核实）
- `VERIFIED -> REVERSED`（记录冲正，不删除原行）
- `VERIFIED -> CORRECTED`（生成更正事实或标记原行，并保留原始事实）
- 证据状态变更产生独立 audit event

不允许：

- AI、Agent、LLM 或 Scheduler 直接冲正/更正 REAL；
- 通过删除交易重置事实；
- 用 `UPDATE` 改变已核实数量、价格或方向；
- 跨 owner 通过已知 record_id 操作；
- 在身份或 epoch 改变后继续提交。

## 3. 事务和身份校验

写服务在 `BEGIN IMMEDIATE` 内：

1. 读取目标记录并应用 owner/chat/epoch 谓词；
2. 校验人工 actor；
3. 重新读取当前绑定并与请求 lineage 比较；
4. 验证允许的状态转换；
5. 写入新状态、事件或更正事实；
6. 在提交前再次校验绑定；
7. 任何身份或数据库失败都回滚。

因此，即使请求开始时角色仍属于用户，执行过程中发生解绑/换 owner，也不能把写入落到新上下文。

## 4. 事实不可覆盖

财务触发器保留并由迁移测试验证：

- 真实交易记录不得直接删除；
- 非草稿交易事实不可原地覆盖；
- REAL 记录的 `is_paper` 约束不能被改写；
- 费用和关联的清理必须符合不可删除/审计规则。

更正不是“改旧行”，而是产生可追溯的新事实和事件。冲正保留原记录，使 FIFO 重算能看到历史并产生相应消耗/状态变化。

## 5. 授权拒绝

测试要求跨 owner 的 verify/reject/correct/reverse：

- 不改变目标记录；
- 不新增事件；
- 不新增更正/冲正事实；
- 不改变 FIFO、reconciliation 或 audit history；
- 不返回可被误认为成功的状态。

同一 owner 的 scope refresh 只改变 `binding_digest` 时，不阻断历史写权限；真正的 owner/chat/epoch 变化才触发拒绝。

## 6. 验证证据

- `tests/audit/p9-3.3.8/real-ledger-ownership-isolation.test.ts`：跨 owner mutation 拒绝和旧 owner 事实不变。
- `tests/audit/p9-3.3.8/migration-and-trigger-integrity.test.ts`：删除/覆盖财务事实触发器和幂等迁移。
- `tests/unit/p9-3.3.1-audit-freshness.test.ts`：验证、冲正、更正后旧 FIFO 标记 STALE。

## 7. 边界

未开放新的自动交易执行或自动冲正能力。所有真实交易仍需人工确认；真实环境中的并发解绑和数据库锁竞争尚未验证。
