# F-05 证据关联幂等性与审计事件

## 原问题

重复调用 linkEvidence 时，关联表保持一条，但仍重复写入 evidence_linked 事件，导致审计事件数量与真实关系变化不一致。

## 修复内容

- src/trading/p9-3-ledger-service.ts
  - 在事务内先读取现有 (record_id, evidence_id) 关联。
  - 不存在时插入并写 evidence_linked。
  - 完全相同时不写任何事件。
  - relation、confidence 或 notes 实际变化时才更新，并写 evidence_link_updated。
  - 事务使用 immediate 模式，降低并发重复写入风险。
  - 继续拒绝跨角色交易与证据关联。
  - 继续执行 ESI 钱包证据、资产证据事实匹配和同一证据复用限制。

## 隔离测试

- tests/unit/p9-3.3.2-ledger-evidence-idempotency.test.ts：3/3 通过。
- 覆盖重复与并发相同关联只产生一条关系和一条事件、实际变化只产生一条更新事件、跨角色关联拒绝。
- P9.3.3.1 钱包幂等回归断言证据关联事件总数保持 1。

## 验证结论

- 代码验证：通过。
- 隔离 SQLite 验证：通过。
- 真实环境验证：未执行。
