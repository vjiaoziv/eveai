# 功能矩阵与架构盘点

## 1. 审计范围

**已通过代码验证**

本矩阵依据 `src/`、`web/src/`、`src/web/server.ts`、数据库迁移和实际页面入口整理。生产运行状态来自 2026-11-04 受控部署后的只读检查；真实业务样本不足的功能明确标为“尚未验证”。

## 2. 功能矩阵

| 功能 | 实现位置 | 前端入口 | 主要 API | 主要数据库表 | 外部依赖 | 现有测试 | 当前状态与限制 |
|---|---|---|---|---|---|---|---|
| 认证/SSO | `src/eve/sso*.ts`、`src/web/auth-routes.ts`、`src/web/web-session.ts` | `LoginScreen`、登录页、角色切换 | `GET /auth/eve/login`、`POST /auth/eve/consent`、`GET /auth/eve/callback`、`GET/POST/DELETE /api/web/session` | `auth_requests`、`web_sessions`、`eve_accounts`、`eve_character_links`、`character_profile` | EVE SSO、Turnstile（可选）、Cookie | `web-security.test.ts`、`web-session-revocation.test.ts`、`web-session-timestamps.test.ts` | **已通过真实环境验证**：现有真实会话可加载实际角色；限制：部署后尚未重新执行完整 SSO 登录往返。 |
| 聊天与 Agent | `src/agent/*`、`src/web/chat-routes.ts`、`src/web/agent-requests.ts` | 聊天首页、对话线程、数据停靠栏、工具状态 | `GET/POST /api/web/conversations`、`GET /api/web/conversations/:threadId/messages`、`POST /api/web/chat`、`GET /api/web/chat/requests/:requestId/events` | `agent_threads`、`messages`、`web_agent_requests`、`thread_summaries`、`usage_events` | OpenAI 兼容模型、EVE-KILL、ESI、SDE、地图/市场工具 | `executor-loop.test.ts`、`tools.test.ts`、`model-call-sites-guard.test.ts`、`p9-safety-and-ai.test.ts` | **已通过真实环境验证**：现有真实对话和 Perimeter 回答可显示；限制：部署后尚未重新发起真实模型写请求。 |
| 市场 | `src/eve/market-*.ts`、`src/web/market-routes.ts`、`src/web/market-ai-search-routes.ts` | 市场概览、订单簿、分析、关注列表、AI 搜索、告警 | `GET /api/web/market/status`、`GET /api/web/market/regions`、`GET /api/web/market/watchlist`、`POST /api/web/market/ai-search`、`GET/POST/DELETE /api/web/market/alerts` | `market_orders`、`market_price_history`、`market_watchlist`、`market_price_alerts`、`market_alert_events`、`market_snapshot_state` | ESI 公共市场、EVE-KILL、模型 | `market-ai-search.test.ts`、`market-ai-search-routes.test.ts`、`p8-5-6-orderbook-depth.test.ts`、`web-security.test.ts` | **已通过真实环境验证**：实际页面和 1,561,888 条 `market_orders` 可读；限制：行情新鲜度不足时仍只提示陈旧，不自动刷新。 |
| 地图/Perimeter | `src/eve-map/*`、`src/eve-board/*`、`src/web/map-routes.ts` | 地图、航线、Perimeter 态势感知、聊天 | `GET /api/web/map/status`、`GET /api/web/map/universe`、`POST /api/web/map/route`、`GET /api/web/map/live`、`POST /api/web/map/ask`、`POST /api/web/map/live/touch` | `map_systems`、`map_edges`、`map_gates`、`map_kill_events`、`map_gate_campers`、`route_monitors`、`route_monitor_kill_dedup` | EVE-KILL、ESI 公共数据、SDE、SSE | `perimeter-radar.test.ts`、`map-*` 测试、`eve-kill-*` 测试 | **已通过真实环境验证**：实际 Perimeter 对话和页面可加载；隔离测试另覆盖 SSE 时序、重连和超时清理。 |
| 资产与估值 | `src/assets/*`、`src/web/asset-routes.ts` | 资产总览、角色资产、库存列表、详情、变化、估值、机会匹配 | `GET /api/web/assets/overview`、`GET /api/web/assets/characters`、`POST /api/web/assets/sync/all`、`GET /api/web/assets/tags` | `real_asset_snapshots`、`real_asset_snapshot_items`、`real_asset_changes`、`real_asset_valuations`、`real_asset_valuation_items`、`real_asset_opportunity_matches` | ESI GET-only、市场订单、SDE | `asset-sync.test.ts`、`asset-valuation.test.ts`、`asset-history.test.ts`、`asset-inventory.test.ts`、`asset-routes.test.ts` | **已通过真实环境验证**：最新快照 513 行、378 个类型、18 个地点；估值绑定旧快照时显示 `STALE`。 |
| P9/P9.3 交易 | `src/trading/p9-*.ts`、`src/web/p9-routes.ts`、`src/web/p9-3-routes.ts`、`src/web/p9-ai-routes.ts` | REAL 交易工作台、P9.3 七个标签、Paper Trading | `GET/POST /api/web/trading/p9/real-ledger/*`、`GET/POST /api/web/trading/p9/real-trades`、P9 机会/方案/风险接口 | `p9_scan_settings`、`p9_real_opportunities`、`p9_trade_plans`、`real_trade_records`、`real_trade_events`、`real_trade_evidence*`、`real_fifo_*`、`real_calculation_runs`、`real_reconciliation_*` | 市场订单、ESI 钱包交易（GET）、人工证据、SQLite | `p9-3-hardening.test.ts`、`p9-3-real-accounting.test.ts`、`p9-core-workflow.test.ts`、`p9-safety-and-ai.test.ts`、`p9-trading-screen-contract.test.ts` | **已通过真实环境验证**：P9.3 页面和 REAL 路由保护；FIFO、PnL、证据、冲正和对账由隔离测试覆盖；限制：真实交易业务闭环没有生产样本。 |
| 飞行员档案 | `src/web/profile-routes.ts`、`src/web/pilot-profile.ts`、`src/eve/user-profile*.ts` | 飞行员档案六个标签 | `GET /api/web/profile/wallet`、`/clones`、`/skills`、`/access`、`POST /api/web/profile/sync` | `character_wallet`、`character_wallet_journal`、`character_orders`、`character_skills`、`character_skillqueue`、`character_clones`、`character_standings` | ESI GET-only、SDE | `web-pilot-profile.test.ts`、`esi-client.test.ts` | **已通过真实环境验证**：真实角色档案页面可加载；限制：钱包/订单同步后的非空真实数据尚未形成。 |
| 设置 | `src/web/settings-routes.ts`、`src/user-model-settings.ts` | 偏好设置、模型设置 | `GET/PUT/DELETE /api/web/settings/model` | `user_model_settings` | 模型提供方、用户级设置 | `executor-model-settings.test.ts`、`web-security.test.ts` | **已通过真实环境验证**：页面可加载；代码审查确认用户级设置隔离。 |
| 示例/支持 | `src/web/examples-routes.ts`、`src/web/transparency.ts` | 功能范例、支持与开销 | `GET /api/web/examples`、`GET /api/web/transparency`、`GET /api/web/transparency/me` | 无专属业务表，读取线程、usage 和公开统计 | 无外部依赖 | `web-security.test.ts`、`static-aggregate.test.ts` | **已通过真实环境验证**：实际页面可加载；公开/个人透明度接口有独立边界。 |
| Telegram/Discord/CLI | `src/telegram/*`、`src/discord/*`、`src/cli/*` | 无 Web 入口；机器人/命令行 | Telegram/Discord 平台回调；CLI 本地命令 | `telegram_accounts`、`telegram_sessions`、`telegram_processed_updates`、`discord_accounts`、`discord_sessions`、`cli_accounts` | Telegram Bot API、Discord API、OpenAI 兼容模型 | `telegram-request-guard.test.ts`、`discord-session.test.ts`、CLI 相关测试 | **已通过代码验证**：会话、去重、访问控制路径存在；限制：生产未配置 `TELEGRAM_BOT_TOKEN`/`DISCORD_BOT_TOKEN`，服务启动日志显示 skipped。 |
| 后台任务 | `src/scheduled/*`、`src/assets/asset-sync-worker.ts`、`src/eve/market-*-worker.ts`、`src/eve-kill/feed-poll.ts` | 无直接页面，状态通过健康检查/数据展示 | `/health`、内部 worker | `web_agent_requests`、`data_source_status`、`usage_daily`、`market_snapshot_state`、`real_asset_sync_jobs` | Croner、外部市场/杀敌/资产源 | worker、health、并发测试 | **已通过真实环境验证**：重启日志显示 market snapshot/history/alerts、asset-sync、map metrics 启动；health queue 为 0/0/0。 |
| 健康检查 | `src/web/health.ts` | 无页面 | `GET /health` | 无写入 | SQLite、Telegram/Discord 可选 | health 测试、部署检查 | **已通过真实环境验证**：HTTP 200，database ok，web_agent_queue ok。 |

## 3. 前后端契约观察

**已通过代码验证**

- 前端页面入口集中在 `web/src/App.tsx`，`activeView` 可选 `chat/market/p9/assets/map/profile/settings/examples/support`。
- 主要页面与 `src/web/server.ts` 中注册的 route module 一一对应。
- P9.3 前端通过 `web/src/api.ts` 调用 `/api/web/trading/p9/real-ledger/*`，并在 P9.3 面板内展示状态、错误、空态和审计信息。
- 资产页新增 `valuationFreshness` 字段，前端在总览和估值标签页分别显示旧快照警告，避免把旧估值与当前库存混为同一口径。
- 市场 AI 搜索的 5xx/429 错误已使用本地化中/英/俄提示，未知错误保留通用回退。

## 4. 测试覆盖空白

**尚未验证**

- 真实 SSO 从点击登录到回调的完整往返未在本轮重新执行。
- 真实 Telegram/Discord 消息派发未执行，因为生产 token 未配置。
- 真实钱包日志、真实市场订单关联、真实证据核实、真实 FIFO 消耗和真实冲正没有样本。
- 没有自动化视觉回归基线；视觉结论来自桌面、平板、移动端实际浏览器检查。
- 没有对生产认证页面执行写操作或破坏性测试，符合只读审计约束。
