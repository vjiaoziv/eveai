# 03 钱包失败队列与增量游标

## 1. 严格字段标准化

统一入口位于 src/trading/p9-3-evidence-service.ts:78-130。

验证规则：

- transaction_id：正安全整数；
- type_id：正整数；
- quantity：正整数；
- unit_price：有限非负数；
- date：可解析的非空日期字符串；
- is_buy：必须是 boolean，不接受字符串；
- location_id：正安全整数。

未知方向不会默认为 BUY。所有非法字段均抛 EsiWalletTransactionValidationError。

## 2. 分页完整性

钱包同步在写入前遍历全部分页：

- 检查 X-Pages 合法且不超过上限；
- 拒绝分页过程中 X-Pages 变化；
- 拒绝空页伪装为完整；
- 要求 from_id 边界严格向前；
- 超最大页数直接失败；
- 在请求前后检查固定角色身份；
- 任一分页失败均不提交本批账本或游标。

位置：src/trading/p9-3-evidence-service.ts:673-763。

## 3. 失败队列

数据表位于 src/db/migrations.ts:826-838：

- 主键：character_id + failure_key；
- transaction_id 可空，用于无 ID 的畸形记录；
- error_code、error、first_failed_at、last_failed_at、retry_count；
- 索引支持按角色和 transaction_id 阻塞游标。

失败记录在同一租约保护下写入。同 ID 失败重试会递增 retry_count。

## 4. 保守游标

候选边界取本批所有有序交易及带 transaction_id 的校验失败的最大 ID。

推进前查询所有 transaction_id IS NULL 或 transaction_id <= candidateBoundary 的未解决失败：

- 有任一带 ID 失败：不推进；
- 有无 ID 畸形失败：不推进；
- 本批有导入失败：不推进；
- 只有全部成功且没有阻塞失败时才推进。

SQL 还使用 CASE 保证持久化游标不会回退。

位置：src/trading/p9-3-evidence-service.ts:515-590。

## 5. 回归场景

通过的测试覆盖：

- 低 ID 失败、较高 ID 成功时游标不越过低 ID；
- 后续同步复现并成功导入失败记录；
- 同一批重复同步不产生重复交易、证据或证据关联；
- 缺少 transactionId/typeId/quantity 等关键字段时不标记完整成功；
- 分页超限和后续页为空时不提交、不推进游标；
- 已人工核实交易在重试中不被覆盖；
- 游标写入临时失败后可幂等恢复。

## 6. 失败队列与游标状态机

### 6.1 失败队列状态机

~~~text
UNSEEN
  │ ESI 行验证/写入失败
  ▼
OPEN / RETRYABLE
  │ 下一轮同步再次处理
  ├── 成功导入并清理同 ID 失败 ──► RESOLVED
  ├── 再次失败 ──► OPEN / RETRYABLE（retry_count + 1）
  └── 长期失败 ──► BLOCKED（当前仅体现为持续 OPEN，无永久失败/人工隔离状态）

BLOCKED
  └── 当前没有自动退避、最大重试或人工解除状态机
~~~

当前数据模型没有单独的 `BLOCKED` 或 `PERMANENTLY_FAILED` 枚举。表中未解决记录会阻止游标推进，因此报告中的 BLOCKED 是行为状态，不是现有数据库值。

### 6.2 游标状态机

~~~text
OLD_CURSOR
  │ 收集全部分页并严格验证
  ▼
CANDIDATE_BOUNDARY
  │ 检查 tx_id IS NULL 或 tx_id <= candidate 的失败记录
  ├── 存在阻塞失败 ──► OLD_CURSOR（不推进）
  ├── 存在本批导入失败 ──► OLD_CURSOR（不推进）
  └── 全部安全处理
          │ 身份 + owner + expiry 事务内复核
          ▼
      ADVANCED_CURSOR（只允许 >= OLD_CURSOR）
          │ 事务失败/旧租约
          └── OLD_CURSOR
~~~

SQL 的单调条件和保守边界避免旧任务回退游标；但单笔交易、证据、失败队列清理和最终游标不是同一个大事务，因此必须依赖幂等重放收敛。

## 7. 交易、证据、失败队列与游标的事务关系

~~~text
同一租约保护
────────────────────────────────────────────────────────────
逐笔记录事务 A
  钱包交易记录 + 证据关联 + 该笔审计事件
       │
       ├─ 成功：提交
       └─ 失败：记录打开状态，写/保留失败队列

最终边界事务 B
  重新检查 pending failures
  + 重新检查身份/角色归属
  + 重新检查 owner/expiry
  + 单调更新角色游标
  + 更新同步任务完成状态
       │
       └─ 任一检查失败：回滚 B，游标保持旧值

跨事务崩溃：
  A 已提交、B 未提交 ──► 下次按 ledgerKey/证据来源幂等重放
~~~

因此现有设计的核心保证是“游标不越过已知失败，跨崩溃可幂等收敛”，而不是“所有相关表在单个原子大事务中同时提交”。后者目前并不存在，属于已记录的风险边界。

## 8. 残余风险

### R-04 重试风暴与永久积压

当前失败队列没有指数退避、最大重试次数、人工隔离状态或告警出口。持续失败会永久阻塞游标，虽然不会静默漏导，但可能造成持续重试和同步积压。

建议后续增加：

- 重试退避时间；
- 最大自动重试次数；
- 永久失败/需人工处理状态；
- 指标与告警；
- 人工解除阻塞的审计流程。

### R-05 跨崩溃窗口

单条交易提交和最终游标提交不在同一大事务中。崩溃会造成“数据已写入但游标未推进”，下次必须依赖 ledgerKey、证据来源引用和幂等关联安全重放。

现有测试验证了幂等重放，但尚未覆盖进程在每条写入之间随机强杀的所有窗口。
