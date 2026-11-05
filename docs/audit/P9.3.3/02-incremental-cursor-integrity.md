# 02 钱包交易增量游标完整性

## 验证状态

- 已通过代码验证。
- 已通过隔离 SQLite 回归测试验证。
- 未在真实 ESI 钱包和真实并发进程上验证。

## 游标语义

采用持久失败记录加保守游标的组合方案：

- last_transaction_id 只表示已经安全处理的同步边界。
- 交易写入失败或记录结构无效时，失败事实写入 real_esi_transaction_failures。
- 只要存在 transaction_id 小于等于候选边界的未解决失败，或存在无 transaction_id 的畸形行，本批次不推进游标。
- 高 ID 的已成功记录可以保留，但下一轮会继续重试低 ID 失败记录。
- 只有整批错误为零、阻塞失败为零，且身份和租约终检通过时，才推进到本批次最大 transactionId。

## 并发和持久化保护

- real_esi_transaction_sync 按 character_id 保存同步状态和游标。
- real_esi_transaction_sync_leases 为每个角色提供跨进程持久租约。
- 只有租约持有者可以提交交易、证据、关联和游标。
- 身份检查与租约检查位于同一写事务内。
- 游标 SQL 使用单调更新，旧任务不能把持久游标回退。
- 失败记录表以 character_id + failure_key 幂等 upsert，并记录首次失败、最近失败和重试次数。
- 高 ID 重复同步不会重复创建交易、证据或证据关联；人工核实事实保持不变。

## 单笔事务边界

每笔交易在独立 SQLite 事务内完成：

- P93LedgerService.upsert() 写 DRAFT REAL 交易；
- P93LedgerService.addEvidence() 写 ESI 钱包证据；
- P93LedgerService.linkEvidence() 建立证据关联；
- 事务开始与提交前再次检查角色归属和租约。

任一步失败即回滚该笔的交易、证据和关联，避免半笔数据。

## 分页保护

- 钱包历史使用 from_id 和 X-Pages 语义。
- 最大允许 10 页，单页预期 2500 条。
- 先收集并验证所有必要页面，再开始持久化。
- 拒绝非正整数、超限、分页过程中变化或不一致的 X-Pages。
- 拒绝后续页为空、边界不前进、重复边界或声明页数未完成。
- 超过最大页数或任何不完整分页时，不提交交易，不推进游标。
- ESI 客户端同时拒绝响应变化、非数组分页体和缺少 X-Pages 的分页结果。

## 严格字段标准化

统一函数 normalizeEsiWalletTransaction() 要求：

- transaction_id：正安全整数；
- type_id：正整数；
- quantity：正整数；
- unit_price：有限非负数；
- is_buy：严格 boolean，不接受字符串 true/false；
- date：非空且可解析，标准化为 UTC ISO；
- location_id：正安全整数。

未知方向不会默认为 BUY，字符串不会隐式转数字，畸形记录不会静默过滤后推进游标。

## 回归场景

| 场景 | 预期结果 |
| --- | --- |
| transactionId 100 失败、101 成功 | 101 可保留；游标不得越过 100，第二次可重试 100 |
| 第一次临时数据库错误、第二次恢复 | 第一次 error；第二次恢复后 100、101 均可导入 |
| 同批重复同步 | 交易、证据、证据关联计数不增长 |
| 缺少或错误 transactionId/typeId/quantity/is_buy | TRANSACTION_DATA_INVALID，不完整成功，不推进游标 |
| ESI 分页超过最大页数 | ESI_REQUEST_FAILED，无账本提交，不推进游标 |
| 声明多页但后续页为空 | 整批不提交 |
| 人工核实交易重试 | 已核实事实、核实时间和证据关系保持不变 |

## P9.3.3.7 所有权转移回归

- 所有权转移后，新所有者使用独立的 owner/chat 游标，即使新交易 transactionId 100 低于旧所有者已同步的 101，也能正常导入。
- 旧所有者保留 transactionId 101 及其证据关系；新所有者记录属于新 owner_chat_id，不看到旧所有者数据。
- 钱包分页请求强制 bypassCache: true，避免复用同一 character_id 下由旧所有者抓取的缓存响应。
- 该回归同时验证了能力快照和身份 fencing 在状态切换后仍然生效。
