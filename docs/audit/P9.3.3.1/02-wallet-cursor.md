# 02. 钱包增量游标完整性

## 当前实现摘要

涉及文件：`src/trading/p9-3-evidence-service.ts`

- 最大页数：10。
- 页大小判断：2500。
- 使用 `from_id` 向历史方向翻页。
- 读取初始游标 `last_transaction_id`。
- 整批先抓取并验证分页，再逐条标准化和持久化。
- 单条失败时记录错误，但继续处理同批合法高 ID。
- 批次末尾只有在 `errors.length === 0` 时才推进游标，否则保持旧游标。
- 交易记录通过 `ledgerKey = esi-wallet:<transactionId>` 幂等 upsert。
- 证据通过 `(character_id, source_system, source_ref)` 唯一索引幂等。

## 已通过源码验证的控制

### 分页完整性

以下情况均返回失败且不提交账本/游标：

- 响应不是数组：`p9-3-evidence-service.ts:265-269`
- `X-Pages` 非正整数：`:245-252`
- 声明页数超过最大页数：`:253-257`
- 分页过程中 `X-Pages` 不一致：`:258-263`
- 声明多页但提前出现空页：`:272-279`
- 分页边界重复或不向前推进：`:283-297`
- 达到最大页数仍未结束：`:299-303`

### 单任务保守游标

```text
newLastId = errors.length === 0
  ? max(当前安全游标, 本批最大 transactionId)
  : 当前安全游标
```

位置：`p9-3-evidence-service.ts:435-456`。

因此单任务内：

- 低 ID 失败、高 ID 成功不会推进到高 ID。
- 高 ID 已成功写入时，下一次会与低 ID 一起重试。
- 重复记录由 `ledgerKey` 和证据唯一索引避免重复实体。

### 已通过隔离测试的场景

| 场景 | 测试 | 结果 |
|---|---|---|
| 严格字段标准化、不把字符串当 boolean | `p9-3.3-evidence.test.ts:101-121` | 通过 |
| 单任务低 ID 失败后重试且幂等 | `p9-3.3-evidence.test.ts:256-283` | 通过 |
| 人工核实后的事实不被幂等重试覆盖 | `p9-3.3-evidence.test.ts:284-306` | 通过 |
| 畸形批次不得报告完整成功或推进 | `p9-3.3-evidence.test.ts:307-325` | 通过 |
| 分页超过最大页数不提交 | `p9-3.3-evidence.test.ts:228-239` | 通过 |
| 声明多页但后页为空不提交 | `p9-3.3-evidence.test.ts:240-255` | 通过 |
| 路由级分页超限返回 502 且游标不变 | `p9-3.3-wallet-routes.test.ts:203-221` | 通过 |
| 游标写失败后交易/证据保留，下一次幂等恢复 | 独立审计 `p9-3.3.1-audit-wallet-concurrency.test.ts:310-348` | 通过 |
| 同角色慢任务不回退游标 | 独立审计 `:161-187` | 失败，F-03 |
| 同角色成功任务不越过另一任务失败记录 | 独立审计 `:189-221` | 失败，F-02 |
| 幂等重试不重复追加证据关联事件 | 独立审计 `:223-248` | 失败，F-05 |

## 已确认缺陷

### F-02（P1）并发成功覆盖低 ID 未解决失败

详见 `01-identity-and-concurrency.md` 与 `08-findings-and-recommendations.md`。

核心问题不是单批次算法，而是两个同角色任务各自基于旧游标独立提交最终状态。单任务保守游标不能提供跨任务安全性。

### F-03（P2）并发完成后写入较小游标

详见 `01-identity-and-concurrency.md`。两个任务都允许无条件更新同一个 `character_id` 行，缺少 CAS/序列化。

### F-05（P2）证据关联 upsert 后无条件追加事件

涉及位置：

- `src/trading/p9-3-ledger-service.ts:638-645`
- 事件表：`src/db/migrations.ts:638-653`

触发条件：

1. 首次同步 transaction 500，创建 1 条交易、1 条证据、1 条关联和 1 个 `evidence_linked` 事件。
2. 人为让游标保持为空并重新同步同一 transaction。
3. `INSERT ... ON CONFLICT DO UPDATE` 命中已有关联，但随后仍无条件 `insertEvent()`。

预期：重试后交易/证据/关联/事件均保持 1 条。

实际：

```text
real_trade_records:        1
real_trade_evidence:       1
real_trade_evidence_links: 1
evidence_linked events:    2
```

证据：`tests/unit/p9-3.3.1-audit-wallet-concurrency.test.ts:223-248`，失败于 `:246-247`。

影响：审计事件数量与真实关系事实不一致，削弱事件溯源可信度。定级 P2。

建议修复：

- 在事务内先查询关联是否已经存在。
- 仅新关联插入时追加 `evidence_linked` 事件。
- 如需记录关系更新，应使用独立 `evidence_link_updated` 事件，而不是把同一语义重复追加。
- 不要删除历史审计事件来“修复”重复。

## 游标设计建议

推荐组合方案：

1. **单角色同步租约**
   - 在数据库持久化 `RUNNING` 任务/lease，以 `characterId` 唯一。
   - 同一角色只允许一个任务拥有提交游标的权利。
   - 过期租约可安全回收，但必须防止旧任务恢复后继续提交。

2. **持久化失败边界**
   - 记录未解决的 transactionId。
   - 游标只能推进到最小未解决失败 ID 之前。
   - 成功高 ID 可写入，但不得改变安全边界。

3. **CAS 终态写入**
   - 更新游标时同时断言当前游标、状态和 ownership/version。
   - 禁止无条件覆盖，禁止较小游标回退。
   - 成功状态不得覆盖仍未解决的 error 状态。

4. **原子最终身份断言**
   - 在同一数据库事务中读取角色链接/所有权版本并写游标。
   - 身份变化则回滚终态并返回 `IDENTITY_CHANGED`。

## 验证边界

- 已用内存 SQLite 验证单进程异步并发、事务失败和数据库触发器故障注入。
- 未验证真实 SQLite 多进程/多实例锁竞争。
- 未验证真实 ESI 限流、超时、ETag 和分页边界组合。
- 未进行生产数据库写入或迁移。