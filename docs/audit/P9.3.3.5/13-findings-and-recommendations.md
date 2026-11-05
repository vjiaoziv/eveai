# Findings 与修复建议

## 状态

`P9_3_3_5_AUDIT_FAILED`

新增缺陷：P1 × 4，P2 × 2。另有 2 项来源确认的 P2 风险。

---

## F-P9335-01 — P1：解绑/重绑后去重产生 COMPLETED job 但当前镜像为空

### 位置

- `src/assets/asset-sync-service.ts:674-690`：只按 `character_id + data_hash + algorithm + version` 去重。
- `src/assets/asset-sync-service.ts:703-717`：非去重路径才替换 mirror。
- `src/db/character-datastore.ts:9-28`：生命周期清理只包含 `character_*` 表。

### 触发链

1. owner 完成一次资产同步，得到有效 snapshot 和 mirror。
2. 角色解绑/重绑，生命周期流程执行 `deleteCharacterData()`，mirror 清空，旧 `real_asset_snapshot` 保留。
3. 新同步返回相同 data hash。
4. 去重命中，旧 snapshot 被复用，新 job 被标记 `COMPLETED`，`itemsCommitted=0`。
5. 当前 `character_assets` 仍为空。

### 预期

- 去重只能在当前 binding 相同且当前 mirror 与新 snapshot 等价时复用。
- 任何 `COMPLETED` 的 current sync 都不得与空/分叉的当前镜像共存。
- 去重不得跨 binding epoch 复用私有资产快照。

### 实际

隔离复现：

- `deduped=true`
- 旧 `snapshotId`
- latest 数量仍为旧值
- `character_assets` 行数为 0
- 新 job 仍为 COMPLETED

### 测试

`tests/unit/p9-3.3.5-audit-findings.test.ts:110-136`：`F-P9335-01/OBSERVED`。

### 影响

当前资产工作台可能把“同步成功”显示为完成，但实时 mirror 为空或与 latest 不一致，破坏资产现值、变化检测和后续估值。

### 修复建议

- 资产 snapshot 增加 owner/binding 代际身份，并在去重时比较。
- 去重前验证当前 mirror 与 previous snapshot 的 item 集合/数量一致。
- 绑定变化后不得跨代复用 snapshot；需要清空、隔离或显式重建镜像。
- 添加“mirror 为空但 hash 相同”与“同一用户删链重绑”“不同 owner 重绑”回归测试。

---

## F-P9335-02 — P1：所有权转移后旧快照和资产历史对新 owner 可见

### 位置

- `src/db/character-datastore.ts:9-28`
- `src/web/auth-routes.ts:393-416`
- `src/eve/sso.ts:403-412`
- `src/web/asset-routes.ts:291-321`

### 触发链

1. 旧 owner 的 `real_asset_snapshots`、items、changes、jobs、valuations 和 opportunity matches 存在。
2. 角色解绑并转移给新 owner。
3. `reassignCharacterOwnership()` / detached cleanup 调用 `deleteCharacterData()`。
4. 该函数只删除 legacy `character_*` 表，不删除或隔离 `real_asset_*` history。
5. 新 owner 通过当前 ownership 校验后，按 `character_id` 查询历史。
6. 路由返回旧 owner 的 snapshot 和 item quantity。

### 预期

所有权转移后，新 owner 不应获得前 owner 的私有资产历史、数量、估值或派生分析。

### 实际

隔离路由测试得到：

- `/api/web/assets/snapshots?characterId=...`：200，包含旧 snapshot。
- `/api/web/assets/snapshots/LEGACY-OWNER-SNAPSHOT`：200，返回 item_id 77、quantity 100。
- legacy mirror 为 0 行，证明清理并未覆盖 immutable history。

### 测试

`tests/unit/p9-3.3.5-audit-findings.test.ts:138-190`：`F-P9335-02/OBSERVED`。

### 影响

跨用户隐私披露和财务信息泄露；违反 SSO 所有权隔离预期。可泄露资产规模、物品数量、历史变化、估值和机会匹配。

### 修复建议

- 为 snapshot/job/change/valuation/match 引入不可伪造的 owner/binding lineage。
- 所有权转移时在同一事务清理、归档到旧 owner 专属存储，或使旧代际不可被新 owner 查询。
- 路由必须同时校验当前 owner 与记录代际，而不是只校验 `character_id`。
- 添加新 owner 列表/详情/变化/估值全部拒绝旧历史的测试。

---

## F-P9335-03 — P1：generic asset sync 绕过 lease/generation/binding fence

### 位置

- `src/eve/character-sync.ts:156-220`
- `src/eve/character-sync.ts:837-850`
- `src/assets/asset-sync-service.ts:328-399、591-690`

### 触发链 A：双写入者

1. `RealAssetSyncService` 完成协调器同步，latest 数量 4。
2. `refreshCharacterDatasets(ctx, ['assets'])` 调用 generic `syncAssets()`。
3. generic 路径不取得 asset job/lease/generation，也不写 snapshot。
4. generic 直接 DELETE/INSERT `character_assets`，写入数量 9。
5. latest 仍为 4，mirror 为 9，没有第二个 job。

### 触发链 B：旧 owner 在途响应写回重绑角色

1. owner A 的 generic asset ESI 请求进入在途状态。
2. 角色解绑并重绑给 owner B，生命周期清理 mirror。
3. owner A 的响应返回。
4. generic sync 无最终 binding/ownership fence，仍写 `character_assets` 并记录 dataset `ok`。

### 预期

资产镜像只能由当前有效协调器任务写入；generic dataset refresh 应复用该协调器或使用等价 fencing。

### 实际

测试 A：

- latest 数量 4
- mirror 数量 9
- job 数 1
- dataset `ok`

测试 B：

- 当前账户 owner 已是 B
- owner A 的旧响应仍写入 quantity 9
- dataset `ok`

### 测试

- `tests/unit/p9-3.3.5-audit-findings.test.ts:193-217`
- `tests/unit/p9-3.3.5-generic-asset-stale-commit.test.ts:102-146`

### 影响

- 违反“全系统只有一个有效资产写入者”。
- 旧 owner 私有数据可能在所有权转移后重新出现。
- 实时镜像与 immutable snapshot/latest 不一致，影响估值和变化记录。
- 绕过 generation、lease、binding epoch、最终 token/owner 校验。

### 修复建议

- 禁止 generic 资产路径直接写 `character_assets`。
- 将 `refreshCharacterDatasets(['assets'])` 路由到 `RealAssetSyncService.syncCharacter()`。
- 若保留 generic 路径，必须实现相同 job/lease/generation 和最终 binding 校验，并禁止成为第二写入者。
- 添加路由级测试，确保持久化前 ownership 改变会使旧响应失败。

---

## F-P9335-04 — P1：缺失或无效 X-Pages 被当作完整一页

### 位置

- `src/eve/esi-client.ts:344-356`：`x-pages` 缺失默认 `1`，非有限值也进入“完成”分支。
- `src/assets/asset-sync-service.ts:492-495`：资产任务再默认 `pagesTotal=1`。

### 触发链

1. 资产端点返回 200 JSON 数组，但没有 `X-Pages`。
2. ESI client 把 totalPages 设为 1 并返回 ok。
3. 资产服务把 pagesTotal 设为 1。
4. 快照和 job 被标记 COMPLETED。

### 预期

对已知分页端点的缺失或非法分页元数据必须失败，或通过独立证据确认只有一页；不得默认成功。

### 实际

测试得到：

- job `COMPLETED`
- `pagesTotal=1`
- partial/mock payload 被写入 snapshot

### 测试

`tests/unit/p9-3.3.5-audit-findings.test.ts:257-270`：`F-P9335-04/OBSERVED`。

### 影响

网络代理、ESI 兼容性变化或 mock/异常响应可导致部分资产集被当作完整快照，进一步污染 latest、变化检测和估值。

### 修复建议

- operation metadata 明确标注“paginated/required X-Pages”。
- 对分页 operation 要求正整数 `X-Pages`，并实际确认页数完整。
- 不要用通用默认 1 处理缺失 header。
- 添加缺失、非数字、0、负数、指数和超预算页测试。

---

## F-P9335-05 — P2：资产总数量聚合可溢出安全整数

### 位置

`src/assets/asset-sync-service.ts:554`：

`rows.reduce((sum, row) => sum + row.quantity, 0)`

### 预期

每个字段虽为正安全整数，聚合仍可能超过 `Number.MAX_SAFE_INTEGER`；必须显式失败或使用可验证的安全聚合。

### 实际

3 行 `Number.MAX_SAFE_INTEGER` 得到非安全整数，且 `BigInt(actual)` 不等于数学总和。

### 测试

`tests/unit/p9-3.3.5-audit-findings.test.ts:272-290`。

### 影响

snapshot 汇总数量失真，影响资产统计、估值完整性和后续导出。

### 修复建议

使用 BigInt 累加后验证在允许范围内，或每一步检查 `Number.isSafeInteger(sum + quantity)`；超限时拒绝提交。

---

## F-P9335-06 — P2：malformed wallet journal 被标记为成功空同步

### 位置

- `src/eve/character-sync.ts:237-278`
- `src/eve/character-sync.ts:837-850`

### 触发链

1. ESI 返回 200 的 wallet journal，但 body 不是数组。
2. `asArray()` 转为 `[]`。
3. `syncWalletJournal()` 返回 rows=0。
4. `refreshDataset()` 写 `status='ok'`、`rows_synced=0`。

### 预期

响应结构非法时应 thrown/标记 error，保留上次成功状态和错误可见性。

### 实际

现有私有 journal 行保留，但 dataset 状态被 `ok/0` 覆盖；malformed payload 被误报为完整成功。

### 测试

`tests/unit/p9-3.3.5-audit-findings.test.ts:219-255`。

### 影响

同步健康度和错误监控失真；操作者会误以为日志已完整刷新，后续基于 journal 的证据/人工核实流程可能使用陈旧数据。

### 修复建议

- wallet journal 响应必须显式 `Array.isArray()`。
- 完整验证 journal 字段后再事务 upsert。
- 非数组、非法行和缺关键字段进入 error/retry，不得返回 rows=0 成功。

---

## R-P9335-01 — P2 风险：scheduled worker 可能永久跳过崩溃后的 RUNNING job

### 位置

`src/assets/asset-sync-worker.ts:20-33`

### 来源确认

due 查询用 `NOT EXISTS (... status='RUNNING')` 排除角色，但没有在该 tick 先调用 `reclaimStaleJobs()`。若崩溃只留下 RUNNING job 且没有人工/API sync，worker 可能永远不再次选中该角色。

### 状态

源码确认；本轮未做生产调度器长跑验证。

### 建议

worker tick 先独立、原子回收过期 RUNNING job，再计算 due 角色，或将回收合并进查询。

---

## R-P9335-02 — P2 风险：lease 无心跳续期，长任务可能被误回收

### 位置

- `src/assets/asset-sync-service.ts:386-395`
- `src/assets/asset-sync-service.ts:337-343`

`renewed_at` 只在领取时写入；过期判断使用 `started_at`。没有发现长任务心跳更新路径。

### 状态

源码确认；本轮未以 >30 分钟真实同步验证。

### 建议

基于 `renewed_at` 实现事务性心跳；最终提交检查最新 lease generation；过期的旧任务不得续期复活。

---

## 未确认的残余风险

`failOwnership()` 若遇到持续 `SQLITE_BUSY`，理论上可能留下 RUNNING job/lease。该路径本轮未能稳定复现，因此不列为已确认 finding，建议后续做可控 busy-timeout 故障注入。

---

## 修复优先级

1. 消除 generic asset writer，统一到协调器。
2. 补齐 binding/owner lineage，修复生命周期清理和路由读取。
3. 去重必须验证当前 mirror 与 binding 代际。
4. 严格分页元数据和安全整数聚合。
5. wallet journal 严格结构与字段校验。
6. 调度器 stale reclamation 和 lease heartbeat。

修复后必须重新执行本轮全部 P1 反例、关键并发 5 次、SSE 5 次、全量门禁和独立安全边界复核。

## 最终判定

- `P9_3_3_5_AUDIT_FAILED`
- 不允许 commit、push、代码冻结、部署、P9.3.4 或 P9.4。
- 不声明 `REAL_ACCOUNTING_OPERATIONALLY_VERIFIED`。
