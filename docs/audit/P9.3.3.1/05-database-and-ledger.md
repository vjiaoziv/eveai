# 05. 数据库与财务账本完整性

## 审计范围

- `src/db/migrations.ts`
- `src/db/schema.ts`
- `src/trading/p9-3-ledger-service.ts`
- `src/trading/p9-3-evidence-service.ts`
- `tests/unit/p9-3-hardening.test.ts`
- `tests/unit/p9-3-real-accounting.test.ts`

## 已通过代码验证的数据库约束

| 约束 | 位置 | 结论 |
|---|---|---|
| REAL 记录强制 `is_paper = 0` | `src/db/migrations.ts:630` | 通过 |
| 账本幂等键唯一 | `:631` `UNIQUE(character_id, ledger_key)` | 通过 |
| 交易事实不可原地覆盖 | `:821-830` 及后续触发器 | 通过 |
| 交易记录不可删除 | `:814-819` | 通过 |
| 财务事件只追加 | `:947-956` | 通过 |
| 事件必须关联同角色有效记录 | `:1046-1054` | 通过 |
| ESI 证据来源唯一 | `:685-686` 唯一索引 | 通过 |
| 证据关联主键幂等 | `:688-696` | 通过 |
| FIFO 消耗唯一 | `:737-738` | 通过 |
| 计算运行保留历史 | `:740-757` | 通过 |
| 同步状态按角色主键 | `:806-812` | 通过 |

### 已验证的账本行为

- `P93LedgerService.upsert()` 对相同 `ledgerKey` 和相同 hash 返回既有记录；不同 hash 拒绝：`src/trading/p9-3-ledger-service.ts:341-345`。
- `P93LedgerService.addEvidence()` 对相同 `(characterId, sourceSystem, sourceRef)` 且相同 payload hash 返回既有证据；不同内容拒绝：`:521-530`。
- 钱包同步记录创建为 `ACTIVE/USER_REPORTED`，不会自动进入 `VERIFIED`；FIFO 只读取人工核实事实。
- 已核实记录的证据关系和财务事实受触发器保护。

## 已通过隔离测试验证

`tests/unit/p9-3-hardening.test.ts`（33/33 通过）覆盖：

- 钱包同步事实不自动 verified。
- 订单、快照、错配钱包证据不能作为已完成交易。
- 同一 ESI 证据不能支持多条交易。
- 已核实记录不能通过服务或直接 SQL 降级。
- 公共调用者不能伪造 ESI 证据。
- 非人工 actor 身份被拒绝。
- 费用和证据关联在核实后受保护。
- 审计触发器缺失或损坏时 fail closed。
- FIFO 重算哈希稳定。
- 冲正、更正、费用和库存转移不删除历史。
- 对账不会把资产变化转换成交易。

`tests/unit/p9-3-real-accounting.test.ts`（7/7 通过）覆盖：

- 人工记录在证据关联和核实前不进入完整账务。
- FIFO 多批次买入/卖出。
- UNKNOWN 成本和缺失库存不进入确定已实现盈亏。
- 冲正/更正和历史保护。
- REAL 与 PAPER 隔离、AI mutation actor 拒绝。
- FIFO 与资产快照对账，不把资产变化当成交。

## 已确认的数据库/账本缺陷

### F-05（P2）幂等关联重试重复追加事件

位置：

- `src/trading/p9-3-ledger-service.ts:638-645`
- 表定义：`src/db/migrations.ts:638-653`

`INSERT ... ON CONFLICT(evidence_id, record_id) DO UPDATE` 本身幂等，但：

```ts
insertEvent(... 'evidence_linked' ...);
```

无条件执行，导致同一证据关联重试生成第二条事件。

影响：

- 审计事件不再一对一反映真实关联变更。
- 事件计数和审计导出可能误导。
- 不造成交易/证据/关联重复，因此定级 P2。

建议：

- `linkEvidence()` 在同一事务内先查询是否已存在关联。
- 仅首次插入时追加 `evidence_linked`。
- 对关联属性变化使用单独事件类型，保留历史，不删除旧事件。

### F-02（P1）同步状态/游标缺少并发线性化

`real_esi_transaction_sync` 只有 `character_id` 主键和普通字段，没有：

- 同步租约/owner token；
- 版本号/CAS 条件；
- 失败队列；
- 任务运行状态与 finished_at。

两个同角色同步可同时读写该行，导致状态被覆盖、游标回退或跨过失败记录。详见 `01-identity-and-concurrency.md` 和 `02-wallet-cursor.md`。

建议：

- 新增持久化同步租约/任务表或使用现有 job 表实现单角色互斥。
- 游标终态更新使用 `WHERE character_id = ? AND (last_transaction_id IS NULL OR last_transaction_id <= ?)` 与状态条件。
- 失败队列记录未解决 transactionId，直到成功或人工隔离。
- 终态身份断言、状态和游标写入同一 `BEGIN IMMEDIATE` 事务。

### F-04（P2）终态身份检查和游标写入没有同一事务边界

检查在 `p9-3-evidence-service.ts:427-433`，游标写入在 `:447-456`。数据库触发器在检查后解绑角色，插入仍成功，服务返回 `ok: true`。

建议：

- 将最终身份检查移入写游标事务。
- 读取 ownership/version/link 并在同一事务内完成条件写入。
- 若任一身份事实不匹配，回滚终态并返回 `IDENTITY_CHANGED`。

## 状态与语义说明

当前钱包同步：

- 创建 `ACTIVE`、`verification_status = USER_REPORTED` 的交易记录。
- 证据初始状态为 `VERIFIED`，因为 ESI 钱包日志是只读来源事实。
- 交易不会自动进入 FIFO；必须人工核实。

如果验收标准将“钱包同步只能创建 DRAFT 交易和证据”解释为字面数据库状态，则当前 `ACTIVE/USER_REPORTED + VERIFIED evidence` 与文字不完全一致。本轮未将其单列为独立缺陷，因为关键安全属性（交易未人工核实、不能进入 FIFO）成立；建议后续统一文档、测试和状态命名口径。

## 验证边界

- 已通过代码验证：REAL/PAPER、不可变事实、事件只追加、证据/关联唯一性、已核实事实保护。
- 已通过隔离测试：故障注入、直接 SQL 失败、重算哈希、冲正/更正、对账隔离。
- 已确认缺陷：并发同步线性化和事件幂等。
- 未验证：多进程 SQLite 锁、生产数据库迁移、真实事务延迟。