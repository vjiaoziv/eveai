# 11 钱包余额 Last-Known-Good

## 1. 代码检查

`src/eve/character-sync.ts:173-184` 对钱包余额执行：

- 必须是 `number`。
- 必须 `Number.isFinite`。
- 必须非负。

任一条件失败即抛错，不执行 `character_wallet` upsert。因此数据库中的最后一次有效余额不会被异常响应的 0 覆盖。

`src/eve/character-sync.ts:647-691` 将同步状态与最后一次成功同步分开：

- `status` 和 `error` 表达本次尝试结果。
- `rows_synced` 与 `synced_at` 只在状态为 `ok` 时更新。
- `error`/`no_scope` 不覆盖上一次成功时间和成功行数。

## 2. 独立测试

测试：`tests/audit/p9-3.3.9/character-sync-adversarial.test.ts:89`。

构造：

1. 先写入一份有效钱包余额。
2. 下一次 ESI 返回非数值或非有限值。
3. 检查余额、最后一次成功时间和同步状态。

结果：

- 最后有效余额保持不变。
- 本次同步状态为失败。
- 失败状态没有复用“最后成功时间”字段伪装成功。
- 测试通过。

## 3. 业务意义

异常响应不会被误记为真实零余额，也不会把失败同步当成成功刷新。对于资金占用、净资产和账户余额展示，保留了明确的 last-known-good 与 failure 语义。

## 4. 证据等级

- 代码验证：已完成。
- 隔离测试数据验证：已完成。
- 真实环境验证：无。
- 尚未验证：真实 ESI 余额精度、客户端/数据库数值范围和生产异常响应分布。
