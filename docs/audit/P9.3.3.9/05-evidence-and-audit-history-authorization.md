# 05 证据与审计历史授权

## 1. 结论

| 项目 | 结果 |
|---|---|
| 跨 owner 子资源访问 | 拒绝，通过 |
| 跨 owner 证据状态修改 | 拒绝，通过 |
| 跨 owner 证据关联 | 拒绝，通过 |
| 原 owner 的全量审计事件 | 可返回，通过 |
| 原 owner 的 record-scoped 审计事件 | 返回空，失败 |
| 缺陷编号/等级 | F-P9339-02 / P2 |

## 2. 跨 owner 子资源验证

测试：`tests/audit/p9-3.3.9/ledger-child-authorization.test.ts:190`。

新 owner 对旧 owner 的交易详情、证据、审计、FIFO 子资源执行读取和修改探测。所有修改请求均被拒绝，原始交易和证据快照保持不变。

该结果说明：未发现通过猜测 `transactionId`、`evidenceId`、`auditEventId`、`batchId` 等标识符直接读取或修改旧 owner REAL 账务数据的路径。

## 3. record-scoped 审计历史缺陷

测试：`tests/audit/p9-3.3.9/ledger-child-authorization.test.ts:265`。

失败结果：

```text
expected [] to have a length of 3 but got +0
```

同一隔离数据库中直接查询得到 3 条事件，但调用：

```ts
P93AuditService.events(db, CHARACTER_ID, recordId, 100, lineageA)
```

返回 0 条。

### 根因

`src/trading/p9-3-audit-service.ts:29-39` 将 SQL 和参数分别构造：

- SQL 顺序：`character_id` → ownership predicate → `record_id`。
- 参数顺序：`characterId` → `recordId` → ownership params。

因此一旦提供 `recordId`，`record_id` 会占用 ownership 参数的位置，导致 owner predicate 无法匹配原 owner 记录。

### 调用链

`P93AuditService.events(db, characterId, recordId?, limit, lineage)`：

1. `resolveRealLedgerLineage` 解析 owner。
2. `ledgerPredicate` 生成 owner SQL 和参数。
3. `where` 先加入 character/owner 条件，再加入 record 条件。
4. `params` 却先加入 `recordId`，再加入 owner 参数。
5. 最终 SQLite 绑定错位，返回空集合。

当前 `/audit` 路由以 `recordId = undefined` 调用，因此全量审计页未触发该错误；缺陷影响任何 record-scoped 服务调用或后续详情路径。

### 影响

- 原 owner 无法看到某条 REAL 交易对应的完整审计历史。
- 可能造成核实、冲正、更正链路的可追溯性缺失。
- 未观察到跨 owner 数据泄露或越权写入，故定为 P2，而非 P0/P1。

## 4. 修复方向

在 P9.3.3.10 中让 SQL 条件和参数按同一顺序构造，例如先追加 ownership params，再追加 `recordId`，或统一通过条件构建器维护 `{sql, params}` 对。必须保留现有无 `recordId` 路径行为，并增加原 owner/新 owner 双视角回归测试。

## 5. 证据等级

- 代码验证：已完成，定位到精确参数顺序。
- 隔离测试数据验证：已完成，稳定失败。
- 真实环境验证：无。
- 尚未验证：生产数据库中的历史事件是否存在同类问题，以及未来是否新增 record-scoped 路由。
