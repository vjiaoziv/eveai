# P9 Implementation Report

日期：2026-11-02（Asia/Shanghai）

## 基线核查

- 仓库：`/home/ubuntu/projects/eveai`
- 分支：`deploy/eve-ai-agent`
- P8.7 基线：`b021fc81f432e7071e75e44156843705fe42e0bc`
- 开始时工作区：干净
- P8.7 交付：`docs/audit/P8.7/` 12 份，完整存在

历史基线与目标一致，无差异需要解释。

## P9.0 实际阻塞项

1. 现有机会接口偏 Paper Trading，缺真实机会生命周期和用户配置贸易中心。
2. ESI 钱包、资产、挂单同步已存在，但没有统一真实交易总览。
3. `trade_ledger` 只能记录草案手工执行，不支持幂等、ESI 去重、审计和 FIFO 全量重算。
4. 库存没有人工确认成本与 UNKNOWN 成本隔离。
5. 前端只有 Paper Trading 页面，没有真实交易工作台。
6. 机会刷新没有按角色启用的自动任务和任务状态。

## 本次最小闭环实现

- 可配置贸易中心、扫描阈值与自动扫描：`src/trading/p9-opportunity-service.ts:426`
- 真实机会四层利润、原始快照、状态机：`src/trading/p9-opportunity-service.ts:609`
- 交易方案生成和状态转换：`src/trading/p9-opportunity-service.ts:744`
- 真实资产/资金/库存/同步总览：`src/trading/p9-real-portfolio.ts:152`
- 人工与 ESI 真实交易、幂等、审计、FIFO 重算：`src/trading/p9-real-trades.ts:88,224,379`
- P9 API：`src/web/p9-routes.ts:47`
- AI 研究分析：`src/trading/p9-ai-analysis.ts:35`
- AI API：`src/web/p9-ai-routes.ts:24`
- 自动机会扫描 worker：`src/trading/p9-opportunity-worker.ts`
- 中文九视图工作台：`web/src/components/P9TradingScreen.tsx:88`

## 安全结果

- P9 没有创建、修改或撤销真实市场订单的 API。
- 唯一新增 ESI 读取是 `get_characters_character_id_wallet_transactions`，GET。
- `fetchWithTimeout` / `fetchRetrying` 继续在派发前调用 `assertEsiHttpDispatch`。
- UI 没有“自动下单”按钮；只允许人工录入和只读同步。
- REAL 与 PAPER 表、API 和页面完全分离。

## 样本限制

真实数据库在迁移前没有 P9 设置、机会或真实交易运行样本。P9 测试使用明确标记的内存夹具；不把夹具当作真实盈利。

## 最终状态

实现状态和验收状态见同目录其他九份报告。`REAL_TRADING_EXECUTION_DISABLED` 必须始终成立。
## 实际验证结果

### 数据库

已执行 `npm run db:migrate`，以下 9 张 P9 表存在：

`p9_scan_settings`、`p9_real_opportunities`、`p9_trade_plans`、`p9_real_trades`、`p9_inventory_lots`、`p9_inventory_moves`、`p9_trade_audit_events`、`p9_esi_transaction_sync`、`p9_job_runs`。

真实数据库当前样本：

- P9 设置：0
- P9 机会：0
- P9 方案：0
- P9 真实交易：0
- P9 库存批次：0
- Paper 账户：0

因此不报告任何真实 P9 盈利、成交率或策略排名。

只读市场数据：

- `market_orders`：1,558,103 行
- `market_snapshot_regions`：68 个区域
- `market_price_history`：32,214 行
- 角色钱包：1
- 角色资产：465 行
- 角色挂单：0

### 测试

```text
npx vitest run
Test Files  217 passed (217)
Tests       2025 passed (2025)
Duration    137.86s

npm run typecheck       PASS
npm run web:check       PASS
npm run lint            PASS
npm run build           PASS
git diff --check        PASS
```

新增 P9 测试：

- `tests/unit/p9-core-workflow.test.ts`：3/3
- `tests/unit/p9-safety-and-ai.test.ts`：3/3

### 运行验证

1. 既有真实服务 `GET /health` 返回 200，数据库检查 `ok`。
2. 使用独立临时数据库和 3100 端口启动新构建，启动成功。
3. 新构建 `GET /health` 返回 200。
4. 未登录访问：
   - `/api/web/trading/p9/settings` → 401
   - `/api/web/trading/p9/scan` → 401

说明 P9 路由已注册且受会话保护；临时实例随后已正常停止。

### 文件变更

预计提交 28 个文件：7 个既有文件修改、10 份 P9 文档、8 个后端 P9 源文件、2 个 P9 测试、1 个前端页面。
## 分项状态

| 状态 | 判断 | 证据与限制 |
|---|---|---|
| `MARKET_DATA_OPERATIONAL` | 成立 | 1,558,103 条订单、68 区域、快照 worker；P9 对过期数据标 `STALE`，不冒充新鲜 |
| `OPPORTUNITY_DISCOVERY_OPERATIONAL` | 成立 | 可配置双策略扫描、状态机、原始快照和 3/3 核心测试 |
| `REAL_ASSET_SYNC_OPERATIONAL` | 条件成立 | 现有只读同步可用；数据库已有 1 个钱包、465 条资产。挂单为 0，真实目标角色授权状态仍需用户确认 |
| `REAL_TRADE_RECORDING_OPERATIONAL` | 成立 | 人工/ESI 幂等记录、修改审计、3/3 工作流测试 |
| `PROFIT_ACCOUNTING_OPERATIONAL` | 成立 | FIFO、部分成交、UNKNOWN 成本隔离和独立重算通过 |
| `PAPER_TRADING_OPERATIONAL` | 成立 | P8.7 已验证，本次全量回归继续通过 |
| `REAL_TRADING_EXECUTION_DISABLED` | 强制成立 | P9 无真实下单/撤单/转账 API，网络层仍阻断非 GET ESI |

“成立”表示工程与测试能力成立，不表示策略盈利或目标 EVE 账户已完成全部授权同步。

## 2026-11-03 P9.1 追加修复

1. **新鲜度判定修正**：机会数据新鲜度改为“快照实际年龄 ≤ 用户 `maxMarketAgeMinutes`”，不再把 ESI `Expires` 头过期直接判为 `DATA_STALE`（`src/trading/p9-opportunity-service.ts` 的 `observation()`）。新增回归测试证明：抓取于 10 分钟前、ESI 缓存已过期 5 分钟的快照在 60 分钟阈值下仍为 `ACTIONABLE`。
2. **贸易中心治理**：`P9Hub.enabled` 支持启用/禁用；`saveSettings` 要求至少一个启用中心，并用 SDE 校验区域存在性与空间站真实归属区域；设置页支持添加/删除/启用。
3. **指定商品扫描**：`scan(db, characterId, { typeIds })` 支持最多 500 个显式 Type ID，API `POST /api/web/trading/p9/scan` 接收 `{typeIds:[...]}`，前端机会页提供输入框。
4. **首页运行状态**：交易总览新增 ESI 行情状态、快照时间、数据行数、整体陈旧标记，以及每个启用贸易中心的区域采集时间/年龄/新鲜度/错误。
5. **机会详情**：机会列表新增“详情”弹窗，展示买卖订单簿、逐档匹配过程（本档成交量与累计）、费用明细、四层利润、风险标记、数据源、买卖快照 ID/时间/年龄、计算版本、关联交易方案，并再次声明真实交易执行禁用。

## 2026-11-03 真实运行验证（隔离数据库）

- 真实 ESI 全量刷新：68 区域 / 1,558,512 行 / 210.4s / 0 错误。
- P9 扫描：522 候选 → 100 入库 → 71 ACTIONABLE + 29 REJECTED。
- 站内套利真实交叉订单：三个贸易中心均为 0（符合撮合机制，不伪造机会）。
- 新构建实例（`DB_PATH=data/verify-p9.db PORT=3107`）：`/health` 200、`/app` 200、`/api/web/trading/p9/settings` 401、`/api/web/market/status` 401、`POST /api/web/trading/p9/scan` 401（未登录按预期拒绝），随后优雅停机。
- 质量门禁：`typecheck`、`web:check`、`lint`、`build` 全部通过；全量 `vitest` 217 个文件 / 2028 个测试全部通过。

生产库说明：生产 `eveai.service`（systemd）在本次验证期间被外部因素以约 15–40 秒间隔反复重启，其 5 分钟行情 cron 未能完成整轮刷新；为避免干扰用户服务，本次未对生产库执行快照覆盖，真实 ESI 验证在隔离副本完成。生产库下一次连续运行超过 5 分钟时会自动补刷新。
