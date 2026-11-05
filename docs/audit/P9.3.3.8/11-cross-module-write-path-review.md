# 11 跨模块写路径复核

## 1. 复核范围

本报告只复核 P9.3.3.8 相关写入边界，不尝试改写所有历史模块。重点是 REAL 财务事实、证据、FIFO、资产镜像、钱包游标、审计和 AI 读取路径。

| 写入路径 | 触发者 | 授权边界 | 结果 |
| --- | --- | --- | --- |
| `P93LedgerService` manual/draft/verify/correct/reverse | 人工用户路由 | session + target character + explicit lineage + immediate recheck | 通过 |
| `P93LedgerService.addEvidence` | 人工用户或 ESI sync | 同一 lineage，来源幂等 | 通过 |
| `P93EsiEvidenceService.syncWalletTransactions` | 用户点击/同步服务 | 固定 character、owner、chat、epoch；手动能力快照 | 通过 |
| `P93FifoService.recalculate` | 人工用户路由 | 只读当前 owner 事实并写当前 owner calculation run | 通过 |
| `P93ReconciliationService.run` | 人工用户路由 | 当前 owner snapshot/valuation/FIFO/trade | 通过 |
| `P93AuditService` | 由人工写动作调用 | audit event 带 lineage | 通过 |
| `RealAssetSyncService` | 角色资料/手动资产同步 | lane lease + generation + binding fence + atomic commit | 通过 |
| P9 settings/opportunity/plan/job writers | 人工/worker | control-plane owner/chat/epoch | 通过 |
| AI analysis | LLM/Agent | 只读；查询 lineage 过滤；没有 REAL mutation tool | 通过 |
| Scheduler | worker | 不取得人工 actor 权限；不能执行真实交易事实写入 | 未扩大 |

## 2. REAL/PAPER 边界

- REAL 查询显式 `is_paper = 0`；
- REAL schema 保留 `CHECK (is_paper = 0)`；
- PAPER 数据不进入 REAL FIFO、对账或 AI 真实财务上下文；
- 测试验证不能把 REAL record 重标为 PAPER；
- 未修改任何允许自动下单或自动执行的接口。

## 3. ESI 边界

钱包和资产请求均通过 `callEsiOperation()`；网络 dispatch 前调用 `assertEsiHttpDispatch()`。只允许 GET。没有开放 POST/PUT/PATCH/DELETE。

## 4. 发现的设计缺口和处置

| 缺口 | 处置 |
| --- | --- |
| 旧钱包同步未自行建立 capability snapshot | 服务内主动 `getEveCapabilities()` |
| 路由只传 userId/chatId | 增加显式 characterId 和 lineage |
| 失败低 ID 可能被高 ID 越过 | 持久失败队列 + 保守游标 |
| 未知开放 lot 污染 realized P&L | 分离 consumption/open-lot 统计 |
| 余额异常被默认 0 | 严格 finite non-negative 校验并保留旧值 |
| 资产先删后过滤 | 全量验证后原子提交 |
| 旧 generation 覆盖新 generation | lease/generation fencing |
| 详情静默截断 | total/hasMore/nextOffset + 固定 snapshot ID |

## 5. 复核结论

未发现新的绕过 owner 边界读取 REAL 的路径；未发现 AI 工具面可写 REAL；未发现新增非 GET ESI 调用。以上结论基于代码审查和隔离测试，不等同于生产环境安全审计。

## 6. 最终代码与测试定位索引（2026-11-05）

用于把上文结论映射到实际实现和反例：

| 边界 | 代码位置 | 测试位置 |
| --- | --- | --- |
| 路由显式 lineage 与人工 mutation | `src/web/p9-3-routes.ts:28-39`、`214-260` | `tests/audit/p9-3.3.8/real-ledger-ownership-isolation.test.ts:215-341` |
| 钱包路由固定目标角色 | `src/web/p9-3-routes.ts:369-400` | `tests/unit/p9-3.3-wallet-routes.test.ts` |
| 冲正/更正 owner 过滤与写前复核 | `src/trading/p9-3-ledger-service.ts:1004-1089` | `tests/audit/p9-3.3.8/real-ledger-ownership-isolation.test.ts:343-404` |
| lineage predicate | `src/trading/p9-3-lineage.ts:73-90` | `tests/audit/p9-3.3.8/real-ledger-multiprocess-ownership.test.ts:231-312` |
| 能力快照和固定角色 | `src/trading/p9-3-evidence-service.ts:749-790` | `tests/unit/p9-3.3-evidence.test.ts:196-208` |
| ESI 分页上限和失败边界 | `src/trading/p9-3-evidence-service.ts:805-891` | `tests/unit/p9-3.3-evidence.test.ts:228-237` |
| 严格字段校验与失败持久化 | `src/trading/p9-3-evidence-service.ts:105-136`、`901-935` | `tests/unit/p9-3.3-evidence.test.ts:100-115`、`334-344` |
| FIFO 已售/未售 UNKNOWN 分离 | `src/trading/p9-3-fifo-service.ts:617-653`、`711-733` | `tests/unit/p9-3.3-fifo.test.ts:91-188` |
| FIFO 新鲜度 | `src/trading/p9-3-fifo-service.ts:150-197` | `tests/unit/p9-3.3-fifo.test.ts:191-228`、`tests/unit/p9-3.3.1-audit-freshness.test.ts:73-104` |
| 钱包余额严格校验与同步状态分离 | `src/eve/character-sync.ts:173-184`、`647-691` | `tests/unit/character-sync.test.ts`、`tests/unit/p9-3.3.2-wallet-balance-integrity.test.ts` |
| 资产全量验证、回读和 dedupe | `src/assets/asset-sync-service.ts:211-268`、`886-905`、`978-991` | `tests/unit/asset-sync.test.ts:268-338` |
| snapshot 详情分页后端 | `src/web/asset-routes.ts:352-396` | `tests/audit/p9-3.3.8/asset-snapshot-pagination.test.ts:106-221` |
| snapshot 详情分页前端 | `web/src/api.ts:250-255`、`web/src/components/AssetScreen.tsx:201-217`、`658-720` | 代码检查；浏览器视觉回归未执行 |
| 迁移事务与重建 | `src/db/migrations.ts:51-52`、`1602-1645`、`1653-1751` | `tests/audit/p9-3.3.8/migration-and-trigger-integrity.test.ts:153-349` |

所有测试均使用隔离 SQLite、测试临时目录或 mock ESI/fetch；没有连接生产数据库，也没有使用真实 EVE 凭证。
