# 02 REAL 账本所有权模型

## 1. 为什么 character_id 不是授权边界

`character_id` 是 EVE 的角色标识，不是本地用户身份。角色可以解绑、重新绑定到另一个用户，或在同一用户的不同 chat lane 中被操作。若账本只按 `character_id` 授权：

- 新所有者可以接触旧所有者历史；
- 同一角色的两个 chat lane 会相互覆盖；
- 冲正、更正、证据读取和 FIFO 计算都可能跨所有权；
- 迁移无法可靠判断旧数据属于谁。

因此 P9.3.3.8 将本地授权边界定义为持久 lineage。

## 2. 四元组定义

```text
(character_id, owner_user_id, owner_chat_id, binding_epoch)
```

| 字段 | 语义 |
| --- | --- |
| `character_id` | EVE 角色 |
| `owner_user_id` | 当前持久绑定的本地用户；无绑定时为 NULL |
| `owner_chat_id` | 具体操作 lane；无 chat 时为 NULL |
| `binding_epoch` | 绑定代际，所有权/绑定变化时递增 |
| `binding_digest` | 写入时授权快照证据，不参与普通读取条件 |

`binding_digest` 的用途是审计“写入时看到了什么授权”，而不是让每次 scope refresh 改变读取可见性。只要 owner/chat/epoch 不变，同一用户可以继续查看自己的历史账本。

## 3. 旧数据的处理

迁移把无法证明归属的旧行保留为：

```sql
owner_user_id IS NULL
owner_chat_id IS NULL
binding_epoch = 0
```

原则：

1. 不把 legacy 行自动归给当前绑定用户。
2. 不把旧 `character_id` 数据带入新 owner 的查询。
3. 不删除 legacy 行，以保留审计和人工核查可能性。
4. 若业务要求恢复旧账本，必须经过独立的人工 reconciliation 流程，并记录决定和证据。

## 4. 解析和谓词

`resolveRealLedgerLineage(db, characterId, lineage)` 有两种模式：

- Web 路由和显式调用者传入 lineage：严格使用该四元组。
- 旧 isolated service fixture 未传 lineage：只有在唯一本地 owner/link 时回退；多 chat lane 时直接报错，禁止猜测。

`realLedgerLineagePredicate()` 生成 owner、chat、epoch 条件。chat 为 NULL 时使用 `owner_chat_id IS NULL`，否则使用 `owner_chat_id = ?`，避免 NULL 比较错误。

## 5. 写入不变量

所有 REAL 写操作必须满足：

1. 解析并固定 lineage。
2. 校验 actor 为人工用户。
3. 在 `BEGIN IMMEDIATE` 内重新读取当前绑定。
4. 比较 owner/chat/epoch。
5. 用四元组写入记录、费用、证据、事件或计算结果。
6. 提交前再次校验绑定没有变化。
7. 失败则回滚，不留下部分写入。

写入层显式写 `owner_user_id`、`owner_chat_id`、`binding_epoch`、`binding_digest`；不能只靠来源表的 character_id 做隐式关联。

## 6. 读取和子查询

以下区域均使用同一 owner predicate：

- 账本列表和详情；
- 证据和事件；
- FIFO lots、consumptions、calculation runs；
- reconciliation runs 和 cases；
- P9 overview 的账本/FIFO 汇总；
- AI analysis 的 trade/fee/lot/consumption 上下文；
- 审计导出和证据关联。

嵌套查询必须给子查询别名并透传相同条件，不能只在最外层过滤。

## 7. 不变量验证

`tests/audit/p9-3.3.8/real-ledger-ownership-isolation.test.ts` 覆盖：

- 新 owner 看不到旧 owner 的记录、证据、事件、FIFO、reconciliation；
- 新 owner 不能 verify、reject、correct、reverse、add evidence；
- 跨 owner 变更后旧 owner 的事实和审计历史不变；
- 同 owner 的 scope refresh 只改变 digest 时仍能看到历史。

`reconciliation-ownership.test.ts` 进一步覆盖对账、AI payload 和“其他 owner 的新交易不应使当前 owner 结果 stale”。

## 8. 状态和限制

- `REAL_ACCOUNTING_READY` 描述财务边界已准备，不等于真实运营验证。
- legacy ownerless 数据没有自动所有权重建；这是有意的安全选择，也是残余人工风险。
- 未在真实生产数据库上执行迁移。
