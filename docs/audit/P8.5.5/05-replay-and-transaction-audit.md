# P8.5.5 防重放、并发与事务原子性审计

## 单次消费

src/trading/trading-pipeline.ts:203-226：

- validateAndConsumePipelineCredential 先重新验证签名、角色、过期和参数。
- 以 credentialId 查询 consumed_pipeline_credentials。
- 已存在则抛出【凭证重放阻断】。
- 插入 credential_id、character_id、draft_id、consumed_at。

数据库迁移位于 src/db/migrations.ts:801 附近。

## 事务原子性修复

修复前 DraftSystem.createDraft 先消费凭证、再写 trade_drafts，两个写入不在同一事务。若 trade_drafts 写入失败，凭证会被消费但草案不存在。

修复后 src/trading/draft-system.ts:31-81：

~~~text
return db.transaction(() => {
  generateDraftId
  validateAndConsumePipelineCredential
  INSERT trade_drafts
  return draft
});
~~~

测试证据：

- tests/unit/p8-5-5-crypto-atomicity.test.ts:99 使用 BEFORE INSERT trigger 强制草案写入失败。
- 断言 consumed_pipeline_credentials 数量为 0。
- 断言 trade_drafts 数量为 0。
- 证明消费记录和草案创建具备原子回滚。

## 并发和幂等

- A13：同一凭证第一次创建草案成功，第二次抛出重放阻断。
- A14：相同 idempotencyKey、不同价格返回幂等冲突。
- A17：同一成交事件重复提交不重复记账。
- A18：已成交订单不能撤销，状态机终结态锁定。
- A22：50 个订单连续占用资金后现金不透支。该测试是同步循环压力，不等同于真实多线程数据库竞争。

## 残余风险

- consumed_pipeline_credentials 主键提供数据库级单次消费保护，但没有单独并发压测数百个相同 credentialId 的并行事务。
- SQLite 写事务串行化降低碰撞风险，但应用层应监控 busy/locked 错误。
- A22 不是真正异步并发；并发资金守恒仍需更高等级压测。

## 结论

凭证单次消费、角色隔离和草案写入事务原子性已修复并有回滚测试。并发证据主要来自同步压力和 SQLite 事务，真实并行竞争仍是残余风险。
