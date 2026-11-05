# 16 发现与修复优先级

## F-P9337-01 — P0：角色转移后 REAL 账本跨 owner 读取与修改

1. **唯一编号**：F-P9337-01
2. **严重等级**：P0（跨用户重大敏感财务数据泄露；未授权修改财务事实）
3. **受影响文件和行号**：
   - `src/web/p9-3-routes.ts:18-25`：当前角色解析。
   - `src/web/p9-3-routes.ts:119-291`：按 `character_id` 读取/修改 REAL 数据。
   - `src/db/migrations.ts:708-749`：`real_trade_records` 无 owner/binding 字段。
   - `src/db/migrations.ts:786-803`：`real_trade_evidence` 无 owner/binding 字段。
   - `src/db/migrations.ts:927-959`：钱包游标/失败队列无 owner/binding 字段。
   - `src/db/character-datastore.ts:9-28`：生命周期清理不覆盖 REAL 表。
   - `src/web/auth-routes.ts:395-419`：所有权转移只删除 profile 数据。
   - `src/eve/sso.ts:403-413`：解绑清理同样不覆盖 REAL 表。
4. **完整调用链**：
   `SSO/角色转移 -> eve_accounts.user_id 改为 B -> deleteCharacterData() -> 用户 B linkedCharacter() -> P9.3 路由按 character_id 查询 -> 旧交易/证据/审计可见 -> POST reverse 修改旧记录`。
5. **前置条件**：
   - 角色从 A 转移给 B，或 A 解绑后 B 重绑。
   - B 有有效 web session、CSRF token。
   - A 曾创建/核实 REAL 交易、证据、审计事件和 FIFO/游标。
6. **最小复现步骤**：
   1. 在隔离 DB 让 A 绑定角色并创建一笔已核实 REAL 交易。
   2. 写入证据、关联、审计事件、FIFO 和 `last_transaction_id`。
   3. 模拟 `reassignCharacterOwnership()`，将账号 user_id 改为 B，删除旧 link，建立 B link。
   4. 以 B 的 session 请求 `GET records`、`GET evidence`、`GET audit`。
   5. 以 B 的 session + CSRF 请求 `POST records/:id/reverse`。
7. **预期结果**：
   - B 看到空集合或 404/403。
   - 旧记录、证据、审计不可见、不可改。
   - 钱包游标不继承。
8. **实际结果**：
   - B 可看到 `OWNER_A_PRIVATE_NOTE`、`OWNER_A_PRIVATE_EVIDENCE` 和旧审计。
   - B 的冲正返回 200，旧记录 `record_state` 变为 `REVERSED`。
   - `last_transaction_id` 仍可被 B 继承。
9. **数据库或运行日志证据**：
   - `tests/audit/p9-3.3.7/owner-ledger-isolation-audit.test.ts`。
   - `logs/p9337-expanded-audit.log`。
   - 断言旧记录可见、旧证据存在、冲正成功和游标值保留。
10. **影响范围**：
   - REAL 交易事实、费用、批次、FIFO、证据、审计事件、计算运行、对账、钱包游标。
   - 新 owner 可污染/冲正前 owner 财务数据。
   - 破坏真实账本归属性与审计链。
11. **修复建议**：
   - 给所有 REAL 表增加 owner/binding lineage，或建立统一 ownership envelope。
   - 所有路由和服务按 lineage 查询/写入/冲正，legacy 无 lineage 记录 fail closed。
   - 转移、解绑、重绑与游标/失败队列分区一起迁移。
   - 添加 A→B 转移、B→A 回切、同一用户多 chat 和多角色测试。
12. **是否阻断下一阶段**：**是**。

---

## F-P9337-02 — P1：多 chat lane 同步删除他人资产 mirror

1. **唯一编号**：F-P9337-02
2. **严重等级**：P1
3. **受影响文件和行号**：
   - `src/assets/asset-sync-service.ts:857`：`DELETE FROM character_assets WHERE character_id = ?`。
   - `src/db/schema.ts:546-563`：mirror 主键只有 `(character_id,item_id)`。
   - `src/assets/asset-sync-service.ts:697`：统一 mirror 插入点。
4. **完整调用链**：
   `RealAssetSyncService.syncCharacter(ctxB) -> 取得 lineage B -> ESI 完整校验 -> DELETE character_id 全部 mirror -> 写入 B mirror -> 创建 B snapshot；A snapshot 保留但 A mirror 消失`。
5. **前置条件**：
   - 同一 user/character 在 A、B 两个 chat lane 分别链接。
   - A 已有成功同步和 completed snapshot。
   - B 触发下一次同步。
6. **最小复现步骤**：
   1. 建立 A、B 两个 chat lane。
   2. A 同步 item 940001/type 34。
   3. B 同步 item 940002/type 35。
   4. 查询 A lane 的 mirror、B lane 的 mirror 和 A snapshot。
7. **预期结果**：A mirror 与 A snapshot 保持一致；B 只替换 B lineage 的 mirror。
8. **实际结果**：A mirror 为 0，B mirror 为 1，A completed snapshot 仍为 1。
9. **数据库或运行日志证据**：
   - `asset-consistency-audit.test.ts` F-P9337-02。
   - `logs/p9337-expanded-audit.log`。
10. **影响范围**：
   - 资产 overview、估值、机会匹配、当前库存和 snapshot lineage。
   - 可能基于错误当前库存做决策。
11. **修复建议**：
   - mirror 删除/插入都使用 lineage predicate。
   - 扩展 mirror 键或单独 lineage namespace。
   - 增加多 chat 并发、解绑重绑和旧任务交错测试。
12. **是否阻断下一阶段**：**是**。

---

## F-P9337-03 — P2：不同 item set 被标为 COMPLETE

1. **唯一编号**：F-P9337-03
2. **严重等级**：P2
3. **受影响文件和行号**：
   - `src/web/asset-routes.ts:147-154`：只比较聚合值。
   - `src/assets/opportunity-match-service.ts:99-110`：同类聚合-only 静态风险。
4. **完整调用链**：
   `GET /api/web/assets/overview -> latest completed snapshot -> current mirror 聚合 SQL -> 比较 items/unique types/locations/quantity -> 返回 dataIntegrity`。
5. **前置条件**：snapshot items 与当前 mirror 的 item/type 组合不同，但四项聚合恰好相同。
6. **最小复现步骤**：
   1. 创建 snapshot items `{34,35}`，总数 2。
   2. 创建 mirror items `{34,36}`，总数 2。
   3. 保持 quantity、location、unique type 数相同。
   4. 请求 overview。
7. **预期结果**：返回 `INCONSISTENT` 或 `STALE`。
8. **实际结果**：返回 `COMPLETE`。
9. **数据库或运行日志证据**：
   - `asset-consistency-audit.test.ts` F-P9337-03。
   - 断言 snapshot types=`34,35`，mirror types=`34,36`，API `dataIntegrity=COMPLETE`。
10. **影响范围**：资产完整性展示、机会匹配和估值输入可信度。
11. **修复建议**：
    - overview 和 opportunity 使用 canonical hash + 完整 item set 比较。
    - 聚合仅做预检；返回明确不一致原因。
12. **是否阻断下一阶段**：否（P2），但应在 P9.3.3.8 修复。

---

## F-P9337-04 — P2：snapshot 详情静默截断

1. **唯一编号**：F-P9337-04
2. **严重等级**：P2
3. **受影响文件和行号**：`src/web/asset-routes.ts:355-360`。
4. **完整调用链**：`GET /api/web/assets/snapshots/:snapshotId -> snapshot lineage 校验 -> SELECT items ORDER BY ... LIMIT 5000 -> 直接返回 {snapshot, items}`。
5. **前置条件**：snapshot items 超过 5000。
6. **最小复现步骤**：
   1. 创建 5001 条 snapshot items。
   2. 请求 snapshot detail。
   3. 比较 `snapshot.total_items` 和 `items.length`。
7. **预期结果**：显式返回截断标志、total/returned 和 continuation；或分页返回完整集合。
8. **实际结果**：`total_items=5001`，`items.length=5000`，无 `truncated`/`totalItems`。
9. **数据库或运行日志证据**：`asset-consistency-audit.test.ts` F-P9337-04；`logs/p9337-expanded-audit.log`。
10. **影响范围**：详情展示、导出、人工核对和基于详情的后续计算。
11. **修复建议**：增加分页/continuation 或明确 truncated 元数据，前端显示截断状态。
12. **是否阻断下一阶段**：否（P2）。

---

## F-P9337-05 — P1：所有权转移继承钱包游标并跳过低 ID 交易

1. **唯一编号**：F-P9337-05
2. **严重等级**：P1
3. **受影响文件和行号**：
   - `src/trading/p9-3-evidence-service.ts:156-161`：按 character 读取游标。
   - `src/trading/p9-3-evidence-service.ts:404-410`：低 ID 且无 failure 时 skipped。
   - `src/trading/p9-3-evidence-service.ts:542-576`：保守游标仍按 character 持久化。
   - `src/db/migrations.ts:927-959`：游标/失败队列无 owner/binding 分区。
4. **完整调用链**：
   `A 同步 101 -> cursor=101 -> ownership 转移给 B -> B 同步返回 100 -> startCursor=101 -> 100<=101 且无 pendingFailure -> skipped ++ -> status=ok -> cursor 保持 101`。
5. **前置条件**：旧 owner 游标高于新 owner 当前最早交易；REAL 同步表未按 lineage 隔离。
6. **最小复现步骤**：
   1. A 以 transaction 101 成功同步。
   2. 转移角色给 B，REAL 表保留。
   3. B 的 ESI 响应仅含 transaction 100。
   4. 以 B 的 pinned ctx 调用 `syncWalletTransactions()`。
7. **预期结果**：B 从自己的空边界开始并导入 100；或明确拒绝继承旧游标。
8. **实际结果**：`ok:true, imported:0, skipped:1, lastTransactionId:101`，`esi-wallet:100` 无记录。
9. **数据库或运行日志证据**：
   - `tests/audit/p9-3.3.7/wallet-owner-cursor-audit.test.ts`。
   - `logs/p9337-expanded-audit.log`。
10. **影响范围**：新 owner 钱包交易永久漏导；REAL 账本、费用、FIFO 和审计链缺失。
11. **修复建议**：
    - 游标与失败队列加入 owner/binding lineage。
    - 角色转移时旧游标隔离/归档，新 lineage 从空边界开始。
    - 增加转移+低 transaction ID 和重复重试测试。
12. **是否阻断下一阶段**：**是**。

## 修复优先级

1. P9.3.3.8-A：修复 F-P9337-01 的 REAL owner lineage 与对象级授权。
2. P9.3.3.8-B：修复 F-P9337-05 的游标/失败队列分区。
3. P9.3.3.8-C：修复 F-P9337-02 的 mirror lineage 删除作用域。
4. P9.3.3.8-D：修复 F-P9337-03/04 的展示一致性、canonical hash compare 和详情分页。
5. 全部修复后必须重新执行本阶段 6 文件 / 34 项专项测试、33 文件 / 171 项历史回归和完整门禁。

## 质量门禁状态

最终快照质量门禁全部通过：

- P9.3.3.7 专项：6 文件 / 34 测试通过。
- 历史回归：33 文件 / 171 测试通过。
- 完整 `npm test`：271 文件 / 2339 测试通过。
- `typecheck`、`web:check`、`lint`、`build`、`audit:public`、`git diff --check`、`git diff --cached --check` 全部 exit 0。
- `build` 仍保留 Vite chunk size warning。

门禁通过不推翻已确认的 P0/P1 反例，也不能替代真实环境验证。审计期间工作区存在并发修改，最终结果以 342 路径快照为准，详见 `15-test-evidence-and-quality-gates.md`。

## 总体判断

F-P9337-01、F-P9337-02、F-P9337-05 阻断下一阶段。最终质量门禁虽全绿，但不能以门禁通过替代产品安全结论，也不能把隔离测试表述为真实环境验证。
