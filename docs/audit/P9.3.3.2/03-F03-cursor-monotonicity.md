# F-03 增量游标完整性与失败重试

## 原问题

低 transaction_id 失败、高 transaction_id 成功时，旧实现可能推进游标，导致低 ID 永久漏导。畸形行、空页、分页超限和重复 ID 也可能让批次被视为完整成功。

## 修复内容

- src/db/migrations.ts 新增 real_esi_transaction_failures。
  - 按 character_id 与 failure_key 持久化失败。
  - 区分有 transaction_id 的交易失败和无 transaction_id 的畸形记录。
  - 保留 first_failed_at、last_failed_at 和 retry_count。
- src/trading/p9-3-evidence-service.ts
  - ESI 分页完整读取并验证 X-Pages、from_id 推进和最大页数后，才允许持久化。
  - 空页、分页不推进、超过 10 页、无效 transaction_id 均不提交本批次。
  - 任何未解决失败只要 transaction_id 小于或等于候选边界，就阻止游标推进。
  - 无 transaction_id 的畸形记录阻止所有游标推进。
  - 已推进游标下方出现待重试失败时，有效更正记录仍会被重放，并在成功幂等导入后清除失败。
  - 重复 transaction_id 的合法行可以幂等导入，但同一响应中畸形的重复行仍保留失败，批次不得标记完整成功。
  - 最终游标写入使用 SQL 单调保护，即使未来调用方绕过服务逻辑也不能回退。

## 回归覆盖

- 低 ID 失败、高 ID 成功不推进游标。
- 临时数据库错误后第二次同步恢复。
- 重复同步不重复创建交易、证据或关联。
- 缺少关键字段不静默成功。
- 超过允许页数不提交、不推进。
- 声明多页但首页或后续页为空不提交；只有 X-Pages=1 的合法空钱包可以成功且不虚构游标。
- 本次复审新增测试实际发现并修复了“声明 2 页时第 2 页为空仍成功”的边界缺陷。

相关测试见 tests/unit/p9-3.3-evidence.test.ts（13/13 通过）、p9-3.3.1-audit-wallet-concurrency.test.ts（8/8 通过）、p9-3.3.2-wallet-lease-integrity.test.ts（5/5 通过）。

## 验证结论

- 代码验证：通过。
- 隔离 SQLite 验证：通过。
- 真实 ESI 分页验证：未执行。
- 残留风险：失败队列已有持久化状态，但没有专门的前端失败列表和人工隔离操作入口。
