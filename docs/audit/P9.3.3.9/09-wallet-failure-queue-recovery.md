# 09 钱包失败队列与恢复

## 1. 设计检查

钱包同步的持久失败表为 `real_esi_transaction_failures`，以 owner/chat/epoch 和稳定 `failure_key` 隔离。字段包括：

- `transaction_id`，malformed 行可为空。
- `error_code`。
- `error`。
- `retry_count`。

服务在提交游标前查询所有 `transaction_id IS NULL OR transaction_id <= candidateBoundary` 的失败；任何未解决失败都会阻止游标推进。

## 2. 低 ID 失败与高 ID 成功

测试：`tests/audit/p9-3.3.9/wallet-adversarial.test.ts:216`。

场景：

1. transaction 100 导入失败。
2. transaction 101 导入成功。
3. 同步结果为 error，游标不能永久越过 100。
4. 下一次同步重试 100。
5. 修复成功后，100 和 101 只存在一份交易、证据和关联。

结果：通过。

## 3. 临时数据库错误恢复

覆盖来源：

- `tests/audit/p9-3.3.9/wallet-adversarial.test.ts`
- `tests/audit/p9-3.3.9/multiprocess-wallet-recovery.test.ts`
- P9.3.3.7/P9.3.3.8 历史钱包恢复测试

故障注入后：

- 失败 transaction 进入 durable queue。
- 游标保持原安全边界。
- 下一次同步重新处理同一 transaction ID。
- 恢复后成功清除对应失败标记。

未观察到一次失败导致永久漏导。

## 4. 多进程幂等恢复

测试：`tests/audit/p9-3.3.9/multiprocess-wallet-recovery.test.ts:129`。

- 使用两个独立进程竞争同一失败低 ID 的重试。
- 连续 5 轮。
- 结果：没有重复交易、重复证据或重复证据关联。
- ledger key、证据来源引用和 lease 机制共同保证重试幂等。

## 5. malformed row 与分页失败

- 缺少关键字段或字段类型错误的行写入稳定 malformed failure key。
- 即使同批次有较高 ID 的合法记录成功，批处理状态仍是 error。
- 游标不推进到“看起来成功”的高位。
- 分页超预算、`X-Pages` 无效或不一致时不提交批次事实，也不推进游标。

## 6. 结论

失败队列、低 ID 阻塞、重试幂等和多进程恢复均通过隔离验证。未发现永久漏导或重复导入问题。

## 7. 证据等级

- 代码验证：已完成。
- 隔离测试数据验证：已完成，包含两进程 5 轮恢复。
- 真实环境验证：无。
- 尚未验证：真实 ESI 限流、真实数据库锁等待、生产网络故障和进程崩溃时机。
