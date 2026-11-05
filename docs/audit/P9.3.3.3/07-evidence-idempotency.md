# 07 证据关联与审计事件幂等性

## 1. 数据约束

src/db/migrations.ts 中：

- real_trade_evidence_links 以 evidence_id + record_id 为主键；
- ESI 证据来源有唯一索引；
- 审计事件表只允许追加；
- 证据关联插入、更新、删除均有触发器；
- 触发器校验记录与证据属于同一角色；
- 单一 ESI 支持证据不能关联到多条 PRIMARY/CORROBORATING 交易。

## 2. 服务级幂等

P93LedgerService.linkEvidence 位于 src/trading/p9-3-ledger-service.ts:593-677。

流程：

1. 校验 record 和 evidence 均属于当前 characterId；
2. 校验证据与交易事实匹配；
3. 拒绝 ESI 证据支持多条交易；
4. 使用 IMMEDIATE 事务；
5. 查询现有 relation；
6. 不存在时插入并写 evidence_linked 事件；
7. 存在且 relation/confidence/notes 完全一致时直接返回，不追加事件；
8. 存在但变化时更新并写 evidence_link_updated 事件。

## 3. 已通过测试

- 重复和并发建立相同关联只产生一条关系和一个事件；
- relation 实际变化时才产生 update 事件；
- 不同角色 record/evidence 交叉关联被拒绝；
- 钱包幂等重试不重复追加 evidence_linked 事件；
- ESI 钱包证据匹配不一致时拒绝关联；
- 已核实记录的证据关系不能原地变更。

## 4. 钱包同步证据状态边界

钱包同步创建的 ESI evidence 初始状态为 VERIFIED，表示 ESI 来源证据本身可信。

这不等于交易已被人工核实：

- P93LedgerService.upsert 创建的交易仍为 DRAFT/PENDING；
- 同步提交后交易为 ACTIVE/USER_REPORTED，等待用户核实；
- FIFO 只读取 record_state = VERIFIED 且 verification_status = VERIFIED 的交易。

因此证据状态不会绕过“钱包日志不等于人工成交确认”的业务边界。

## 5. 结论

证据关联幂等性在当前源码和隔离测试范围内通过。

仍未在生产环境验证并发 API、大规模审计事件和真实人工核实流程。
