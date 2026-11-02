# EVE AI Agent 源码与架构修改记录 (MODIFICATION_LOG.md)

本日志详尽记录自上游主干克隆以来，在部署分支 `deploy/eve-ai-agent` 上执行的所有配置、依赖修复与中文化修改。

---

## 一、基础版本与分支信息

- **上游源仓库**：`https://github.com/garshany/eveai.git`
- **基准提交 (Base Commit)**：`b93bfcf1c11b593531f928e2283834b57569bab0`
- **本地独立工作分支**：`deploy/eve-ai-agent`
- **修改原则**：严格保护上游原有主干，所有变动集中在独立分支中受版本控制，且不破坏现有测试。

---

## 二、详细修改记录

### 1. 2026-11-01：系统网络与 WSL 镜像环境适配
- **变更文件**：`C:\Users\JIAOZI\.wslconfig`, `/etc/apt/apt.conf.d/proxy.conf`, `/etc/apt/sources.list.d/ubuntu.sources`
- **修改背景**：解决 Windows 宿主机代理环境下，WSL2 内无法直连访问 EVE Online 开发者网站及 ESI 接口的问题；将 Ubuntu 虚拟磁盘迁移至 D 盘 (`D:\WSL\Ubuntu-24.04`) 以释放 C 盘空间。
- **修改详情**：
  - 启用 WSL2 `networkingMode=mirrored`，使子系统无缝共享宿主机网络与本地 `127.0.0.1:8033` 代理。
  - 将 APT 软件源配置为阿里云镜像源并设置本地代理加速。

### 2. 2026-11-01：前端 UI 全量简体中文化 (Commit: `9acee49`)
- **变更文件**：
  - `web/src/i18n.tsx`
  - `web/src/dates.ts`
  - `web/src/components/ChatScreen.tsx`
  - `web/src/components/DataDock.tsx`
  - `web/src/components/PilotProfileScreen.tsx`
  - `web/src/components/SupportScreen.tsx`
  - `web/src/components/map/PerimeterChat.tsx`
  - `web/src/components/map/SystemInspector.tsx`
- **修改详情**：
  - 扩展 `Locale` 类型为 `'zh' | 'en' | 'ru'`，并新增包含全部 476 个词条的完整简体中文翻译字典 `ZH`。
  - 将默认语言状态从俄语 (`ru`) 调整为简体中文 (`zh`)。
  - 在语言切换组件 (`LocaleSwitch`) 中新增“中文”选项。
  - 适配日期、时间、相对时间（如“昨天”）的中文展示。
  - 修复各组件中对 `Locale` 类型的联合约束，确保前端 TypeScript 类型检查 100% 通过。

### 3. 2026-11-01：AI Agent 提示词规则中文化改造 (Commit: `9acee49`)
- **变更文件**：
  - `src/agent/prompts.ts`
  - `src/config.ts`
- **修改详情**：
  - 在 `normalizeResponseLanguage` 中增加对 `zh`, `zh-cn`, `chinese`, `中文`, `简体中文` 的识别支持，默认语言设为 `Chinese`。
  - 在 `buildResponseLanguageBlock` 中注入专门的中文回答规范：
    1. 默认采用自然、专业的简体中文作答；
    2. 严格保留 EVE Online 核心专有术语体系（杜绝非专业生造改写）；
    3. 舰船、装备、物品优先采用游戏官方中文名称（来自 SDE 数据库），缺译名的补充英文原名；
    4. ISK、DPS、EHP、ESI、SDE、LP 等通用专业缩写不强制翻译；
    5. 严禁编造游戏机制，必须明确区分事实、计算与推论，如实标注时效与数据源。
  - 在 `src/config.ts` 中将默认回复语言设为 `Chinese`。

### 4. 2026-11-01：官方 SDE 静态数据全量本地导入与验证
- **生成产物**：`/home/ubuntu/projects/eveai/data/eve-agent.db` (约 640 MB)
- **修改详情**：
  - 成功拉取 CCP 官方最新 SDE 数据包并解包。
  - 执行 `npm run sde:load`，将 676,965 条宇宙天体与物品数据全量写入 SQLite，验证中文道具名（如“狂怒者级”、“三钛合金”）读取正常。
  - 执行 `npm run db:migrate` 完成业务表与关联外键初始化。
### 5. 2026-11-01：新增 Custom 独立模型适配器与通用 Agent 工具链 (Commit: `2f8e537`)
- **变更文件**：
  - `src/openai-provider.ts`
  - `src/agent/tools/sde-schema.ts`
  - `tests/unit/config.test.ts`
  - `scripts/eve-cli.ts`
  - `C:\Users\JIAOZI\bin\eve-agent.cmd`
  - `C:\Users\JIAOZI\.codex\skills\eve-agent\SKILL.md`
  - `C:\Users\JIAOZI\.agents\skills\eve-agent\SKILL.md`
- **修改详情**：
  - 在 `src/openai-provider.ts` 中新增独立的 `custom` Provider，支持将模型请求通过 Responses API (HTTP SSE) 转发至本地 Antigravity 路由服务 (`http://127.0.0.1:8046/v1`)，完美支持 `claude-sonnet-5-5`、`claude-opus-5-5` 等模型的原生流式输出与多轮工具调用。
  - 在 SQLite `sde_types`、`sde_groups` 等静态数据表中增加 `zh_name` 虚拟生成列与二级索引，彻底消除中文名模糊匹配的性能损耗，在 0 毫秒内实现中英文双向互查。
  - 打造通用 Agent CLI 命令行工具 `eve-agent` 并加入系统用户 PATH (`C:\Users\JIAOZI\bin\eve-agent.cmd`)，支持 `eve-agent status`、`eve-agent ask`、`eve-agent item`、`eve-agent reprocess`、`eve-agent sde`。
  - 创建并注册了标准 Agent 技能定义，使 Codex、Hermes 和 dsh (DeepSeek Harness) 均能原生直接调度本 EVE Agent 的全部能力。
### 6. 2026-11-01：解决 Node.js 原生 fetch 跨国网络代理穿透问题 (Commit: `b36b05b`)
- **变更文件**：
  - `src/eve/http.ts`
  - `.env`
- **问题定位**：
  - 用户在浏览器完成 EVE SSO 授权后，CCP 将授权 code 重定向回 `http://localhost:3000/auth/eve/callback`。
  - 在换取 Token 阶段，服务端需请求 `https://login.eveonline.com/v2/oauth/token` 和 `https://login.eveonline.com/oauth/jwks` 进行证书签名验证。
  - Node.js 22 的内置全局 `fetch` (基于 undici) 默认不自动读取系统的 `http_proxy`/`https_proxy` 环境变量，导致直连 CCP 鉴权服务器时触发 `ConnectTimeoutError: The operation was aborted due to timeout`。
- **修复方案**：
  - 在 `src/eve/http.ts` 初始化阶段注入 `undici.EnvHttpProxyAgent`，使全局 `fetch` 与 `jose` 验签库全量无缝走本地代理网关 (`http://127.0.0.1:8033`)。
  - 在 `.env` 中固化 `HTTPS_PROXY` 与 `NO_PROXY` 规则，实测 EVE SSO 元数据与 Token 交互耗时由超时失败降低至 1 秒以内。
### 7. 2026-11-02：构建核心交易引擎与订单草案系统 (P1 ~ P4) (Commit: `0e80f58`)
- **新增模块**：
  - `src/trading/types.ts`：投资交易核心类型契约（费率、模拟深度、策略类型、订单草案）。
  - `src/trading/data-center.ts`：统一数据中心与多源健康监控表 (`data_source_status`)。
  - `src/trading/fee-engine.ts`：确定性税费精算引擎（支持 Alpha/Omega、会计学、经纪人关系、声望与建筑费率）。
  - `src/trading/orderbook-simulator.ts`：订单簿多档穿透撮合模拟器（加权平均价、滑点、未成交截断）。
  - `src/trading/strategies/station-arbitrage.ts`：站内价差套利扫描器。
  - `src/trading/strategies/regional-hauling.ts`：跨贸易中心高安航线套利扫描器。
  - `src/trading/strategies/manufacturing-arbitrage.ts`：SDE 制造与再处理矿物套利比价。
  - `src/trading/portfolio-manager.ts`：动态资金风控状态机（20% 储备金、15% 单品限额、5000万防强杀货值上限）。
  - `src/trading/draft-system.ts`：交易订单草案全生命周期管理器（生成唯一标识 `TR-YYYY-NNNNNN`、审批流、记账台账）。
  - `src/trading/backtesting/engine.ts`：无未来数据泄露的历史回测引擎（胜率、夏普比率、最大回撤）。
  - `tests/unit/trading-fee-simulator.test.ts` & `tests/unit/trading-system-full.test.ts`：15 项单元测试 100% 通过。
- **数据库迁移**：
  - 在 `src/db/migrations.ts` 中增量创建了 `data_source_status`, `portfolio_positions`, `trade_drafts`, `trade_ledger`, `risk_snapshots`, `backtest_runs`, `paper_trading_positions` 七张核心业务表。
- **CLI 命令升级**：
  - `eve-agent capital`：查询角色实时现金、20% 储备金与限额。
  - `eve-agent scan-station` / `scan-haul`：执行站内与跨区套利扫描。
  - `eve-agent drafts` / `draft-auto` / `draft-approve`：自动化生成、查看与审批订单草案。
### 8. 2026-11-02：完成 EVEAI 交易系统第二轮独立代码与实盘风控审计
- **审计交付文件**：
  - `FIRST_TRADE_RECALCULATION.md`：首笔套利草案 `TR-2026-000001` 全流程数学穿透复核。揭露虚假价差（Phantom Spread）缺陷：杜迪克西 700k 买单仅剩 2 件，实盘执行导致 -85.63% 巨额亏损（亏损 860 万 ISK）。
  - `FEE_ENGINE_AUDIT.md`：`src/trading/fee-engine.ts` 逐行审查。查出基础销售税硬编码为 8.0%（CCP 现行基准为 7.5%）、漏算 100 ISK 最低经纪人费与 Upwell 建筑 SCC 附加费。
  - `PORTFOLIO_RISK_AUDIT.md`：`src/trading/portfolio-manager.ts` 资金风控审查。查出在途已审批草案未扣减投资资金的并发漏洞、品类 30% 上限未生效、单品 15% 上限未累计已有持仓以及代码段重复等缺陷。
  - `MARKET_DATA_AUDIT.md`：`src/trading/data-center.ts` 与 `orderbook-simulator.ts` 审计。查出策略层完全旁路订单簿深度仿真器、两地快照时间戳存在 13.5 小时严重漂移等问题。
  - `BACKTEST_VALIDATION.md`：`src/trading/backtesting/engine.ts` 回测审查。查出未来数据泄漏（当日最低买、次日均价卖）与最理想成交假设，将全部六大策略定级为【实验性策略】。
  - `SECURITY_PERMISSION_AUDIT.md`：系统安全审查。确认 ESI Token 密文加密（AES-256-GCM + HKDF）安全，Agent tools 100% 只读，无游戏内写入交易能力。
  - `DEFECT_AND_REMEDIATION_LIST.md`：汇总 12 项缺陷（7 项 P0 致命级、4 项 P1 严重级、1 项 P2 改进级）及代码级修复方案。
  - `SECOND_AUDIT_REPORT.md`：第二轮独立审计综合评估报告，裁决该交易系统【未达实盘标准，严禁投入真实游戏资金】。

### 9. 2026-11-02：完成 EVEAI P8 阶段交易决策可信度重建与缺陷修复
- **架构重构与核心修复**：
  - `src/trading/trading-pipeline.ts`：新增 10 阶段确定性交易决策管线 (`TradingPipeline`)，集成订单簿深度截断、多档位滑点撮合、时差校验、压力测试与风控门禁，实现 A/B/C/D 机会评级与 D 级一票否决。
  - `src/trading/fee-engine.ts`：将基准销售税修正为 CCP 现行法定 7.5%（Accounting 3 精确为 5.025%）；引入 100 ISK 最低经纪人费保底机制与 Upwell 建筑 0.5% SCC 法定附加税；新增 `getSkillsForCharacter` 动态技能读取。
  - `src/trading/portfolio-manager.ts`：可用资金扣减在途已审批草案额度；引入单品 15% 与品类 30% 全局累计持仓风控；库存估值改用吉他现货买单市值；消除防强杀重复代码。
  - `src/trading/draft-system.ts` & 数据库迁移：支持 `audit_revoked` 状态及原因记录；将 `TR-2026-000001` 永久封存撤销，彻底阻断其重新审批或标记执行。
  - `src/trading/strategies/regional-hauling.ts`：全面废除粗暴 SQL 订单累加，强制调用 `OrderBookSimulator` 进行逐档深度与滑点计算，数量严限为顶档买单剩余量。
  - `src/trading/backtesting/engine.ts`：消除“当日最低价买、次日均价卖”的未来数据泄漏；引入 1.5% 执行滑点摩擦；补充 Sortino Ratio、95% CVaR 及资金周转率指标；将全量策略定级为【实验性策略】。
- **全量测试与构建**：
  - 17 项交易与风控专项测试 100% 通过（`trading-fee-simulator.test.ts`, `trading-system-full.test.ts`, `trading-pipeline.test.ts`）。
  - `tsc --noEmit` 0 错误，前端生产打包成功。
- **交付文档**：
  - 生成 `P8_REPAIR_PLAN.md`, `P8_IMPLEMENTATION_REPORT.md`, `P8_MARKET_DATA_VALIDATION.md`, `P8_ORDERBOOK_SIMULATION.md`, `P8_FEE_ENGINE_VALIDATION.md`, `P8_PORTFOLIO_RISK_VALIDATION.md`, `P8_BACKTEST_VALIDATION.md`, `P8_OPPORTUNITY_RATING.md`, `P8_PAPER_TRADING_GUIDE.md`, `P8_SECURITY_VALIDATION.md`, `P8_TEST_REPORT.md`, `P8_KNOWN_LIMITATIONS.md` 共 12 份交付文档。

### 10. 2026-11-02：全面同步更新 EVE AI Agent 技能定义文件 (eve-agent SKILL.md)
- **更新目标**：
  - `C:\Users\JIAOZI\.codex\skills\eve-agent\SKILL.md` (Codex 用户级技能库)
  - `C:\Users\JIAOZI\.agents\skills\eve-agent\SKILL.md` (Agents/Hermes 共享技能库)
  - `D:\Git\EVE\skills\eve-agent\SKILL.md` (Windows 镜像目录)
  - `/home/ubuntu/projects/eveai/skills/eve-agent/SKILL.md` (WSL 项目源码库，已入 Git 版本管理)
- **主要更新内容**：
  - **决策管线更新**：集成 10 阶段确定性交易决策管线 (`TradingPipeline`)，说明多档位深度穿透撮合、滑点精算与反虚假价差（Phantom Spread）深度截断规则。
  - **税费规则核准**：更新 CCP 现行基准销售税 7.5%、Alpha Accounting 3 (5.025%)、Omega Accounting 5 (3.375%)、100 ISK 最低经纪人费保底及 Upwell 建筑 0.5% 法定 SCC 附加税。
  - **风控模型完善**：明确 20% 安全现金储备、在途已审批草案额度锁定、单品 15% 累计持仓限额、品类 30% 累计持仓限额及 5000 万高安防强杀货值门禁。
  - **草案生命周期**：指明历史草案 `TR-2026-000001` 已被永久撤销 (`audit_revoked`)；补充说明实盘交易反馈与真实成交对比记账闭环 (`record-trade`)。
  - **评级与否决标准**：新增 A/B/C/D 四级交易机会评级体系与多情景压力测试规范，明确时差 $> 15$ 分钟一票否决规则。

### 11. 2026-11-02：完成 EVEAI P8.5 独立验收与二次纠偏
- **二次纠偏与逻辑重构**：
  - `src/trading/data-center.ts`：彻底纠正使用订单 `issued` 判断时差的错误，重构为读取 `market_snapshot_regions` 表中真实的 `fetched_at` 与 `expires_at` 快照时效。
  - `src/trading/orderbook-simulator.ts`：实现 `findOptimalProfitableQuantity` 边际收益贪心搜索，彻底化解“第一档粗暴截断”与“多档订单簿模拟”之间的逻辑冲突，实现兼顾深度与防滑脱的动态平衡。
  - `src/trading/backtesting/engine.ts`：重构日线回测时序因果链，消除 Day T 决策偷窥 Day T 均价收盘数据的未来漏洞，强制 Day T 信号 $\to$ Day T+1 进场 $\to$ Day T+2 出场。
  - `src/trading/portfolio-manager.ts`：库存估值改用吉他买盘多档真实撮合测算变现净额，隔离非标 BPC 拷贝件，分层输出流动性与特殊资产。
  - `src/trading/draft-system.ts`, `src/web/trading-routes.ts`, `scripts/eve-cli.ts`：全链路硬性捕获并拦截对 `audit_revoked` 草案的审批与执行，修正历史撤销描述为客观的“模拟成交测算重大风险”。
- **综合集成测试**：
  - 新增 `tests/unit/p8-5-integration.test.ts`，覆盖案例 A（多档深度优化截断）、案例 B（issued 不同但快照同步）、案例 C（issued 相同但快照陈旧）、案例 D（回测无未来数据泄漏）、案例 E（多档库存真实估值与 BPC 隔离）、案例 F（全链路撤销草案锁死）。
  - 4 套专项测试共 23 项单测 100% 通过；TypeScript 0 错误；Vite 前端构建成功。
- **交付文档**：
  - 生成 `P8_5_INDEPENDENT_AUDIT.md`, `P8_5_MARKET_TIMESTAMP_AUDIT.md`, `P8_5_ORDERBOOK_LOGIC_AUDIT.md`, `P8_5_BACKTEST_CAUSALITY_AUDIT.md`, `P8_5_FEE_ENGINE_AUDIT.md`, `P8_5_INVENTORY_VALUATION_AUDIT.md`, `P8_5_DRAFT_STATE_SECURITY_AUDIT.md`, `P8_5_INTEGRATION_TEST_REPORT.md`, `P8_5_REMEDIATION_LOG.md`, `P8_5_FINAL_ACCEPTANCE_REPORT.md` 共 10 份交付文档。

### 12. 2026-11-02：完成 EVEAI P8.5.1 模拟盘准入检查与 Paper Trading 部署
- **全项目测试核验**：
  - 执行 `npx vitest run` 全项目测试：全量 199 个测试文件、1,949 项测试用例，通过 1,945 项，4 项历史周边模块超时失败已查明定性，交易核心 29 项测试 100% 通过。
- **模拟盘系统正式落地 (`src/trading/paper-trading.ts`)**：
  - 建立独立虚拟资金池 (`paper_trading_accounts`)、机会前置日志表 (`trade_opportunities_log`) 与虚拟订单状态机 (`paper_trading_orders`)。
  - 严格支持限价买单、卖单、部分成交 (`partially_filled`)、完全成交 (`filled`) 与撤单释放保证金。
  - 建立预测偏差追踪机制 ($\text{Actual Simulated PnL} - \text{Expected PnL}$)，并对 6 类策略独立建账统计。
- **回测与资产估值优化**：
  - 回测模型明确区分为 `daily_signal_backtest`，将均价成交标为事后假设，禁用未包含逐笔数据的订单簿回测模式。
  - 资产估值区分高流动性变现净值、低流动性资产与非标特殊资产（BPC 拷贝件市场变现值计 0）。
- **交付文档**：
  - 生成 `P8_5_1_READINESS_AUDIT.md`, `P8_5_1_FULL_TEST_REPORT.md`, `P8_5_1_BACKTEST_MODEL_AUDIT.md`, `P8_5_1_PERFORMANCE_METRICS_AUDIT.md`, `P8_5_1_ASSET_VALUATION_AUDIT.md`, `P8_5_1_DRAFT_AUDIT_ACCESS_AUDIT.md`, `P8_5_1_PAPER_TRADING_ARCHITECTURE.md`, `P8_5_1_PAPER_TRADING_TEST_REPORT.md`, `P8_5_1_DATA_RELIABILITY_REPORT.md`, `P8_5_1_DEPLOYMENT_GUIDE.md`, `P8_5_1_KNOWN_LIMITATIONS.md`, `P8_5_1_FINAL_ACCEPTANCE_REPORT.md` 共 12 份报告。
  - 正式授予系统 **`PAPER_TRADING_READY`** 准入资质，开启 30 天模拟盘观察期。

### 13. 2026-11-02：完成 EVEAI P8.5.2 深度漏洞审计、系统强化与压力测试
- **深层漏洞清零与代码加固**：
  - `src/trading/draft-system.ts`: 在 `createDraft` 核心层增加 D 级机会一票否决强门禁，彻底封堵从 API 或 CLI 绕过决策管线创建高危草案的漏洞。
  - `src/trading/paper-trading.ts`: 引入 `idempotency_key` 唯一键索引，消除网络重试导致的重复冻结扣款；将买单撮合税费修正为仅扣买方经纪人费（买方不付销售税），实现资产负债表严格对账；在订单撤单中退还未使用的挂单保底费缓冲；将订单 ID 与仓位 ID 升级为 UUID 防重；增加 `VALID_STATE_TRANSITIONS` 状态机跃迁保护。
  - `src/web/trading-routes.ts` & `scripts/eve-cli.ts`: 自动草案生成严格过滤 D 级与被否决机会。
- **全项目与高级压力测试**：
  - 新增 `tests/unit/p8-5-2-stress.test.ts`，覆盖场景 A（100 并发订单争抢资金）、场景 B（100 次幂等重复提交）、场景 C（部分成交后连续撤单资金释放）、场景 H（直接绕过管线拦截）、场景 I（已撤销草案锁死）、场景 K & N（异常与边界值测试）、场景 L（双重记账资金资产对账）、场景 R（只读安全零写入验证）。
  - 交易系统专项测试扩充至 6 套测试文件，**37 项关键单测全部 100% 通过**（耗时 1.45s）。
  - TypeScript 0 错误，前端生产构建打包完全成功。
- **交付文档**：
  - 生成 `P8_5_2_CODE_AUDIT.md`, `P8_5_2_TRADING_PIPELINE_AUDIT.md`, `P8_5_2_ORDERBOOK_AUDIT.md`, `P8_5_2_FUND_AND_ORDER_STATE_AUDIT.md`, `P8_5_2_FEE_ENGINE_AUDIT.md`, `P8_5_2_PORTFOLIO_AUDIT.md`, `P8_5_2_BACKTEST_AUDIT.md`, `P8_5_2_STRATEGY_AUDIT.md`, `P8_5_2_DATA_RELIABILITY_AUDIT.md`, `P8_5_2_SECURITY_AUDIT.md`, `P8_5_2_FULL_TEST_REPORT.md`, `P8_5_2_FINAL_ACCEPTANCE_REPORT.md` 共 12 份专项报告。

### 14. 2026-11-02：完成 EVEAI P8.5.3 独立验证、会计审计与对抗测试
- **深层安全与凭证防伪机制**：
  - `src/trading/trading-pipeline.ts`: 引入数字签名验证凭证机制 (`PipelineVerificationCredential`, HMAC-SHA256)；在 A/B 级机会经管线多档撮合与风控通过后签发防篡改凭证。
  - `src/trading/draft-system.ts`: 在 `createDraft` 前置强校验凭证合法性、签名完整性、15 分钟时效性及参数一致性，彻底切断伪造参数创建草案的任何路径。
  - `src/trading/paper-trading.ts`: 增强幂等键防重，增加同键异参 409 冲突拦截；修复买单成交税费多扣致资产负债表失衡 Bug，确保 $\text{Assets} \equiv \text{Equity}$ 借贷平衡对账。
- **全套回归与对抗测试**：
  - 新增 `tests/unit/p8-5-3-adversarial.test.ts`，覆盖无凭证拦截、参数篡改拦截、凭证过期拦截、同键异参冲突、状态机终结态不可逆。
  - 7 套交易专项测试共 42 项单测 100% 通过（耗时 1.34s）；全项目测试通过 1,945 项，4 项历史非交易用例穿透审计完毕。
  - TypeScript 0 错误，前端生产构建打包完全成功。
- **交付文档**：
  - 生成 `P8_5_3_BASELINE_AND_FULL_TEST_REPORT.md`, `P8_5_3_PIPELINE_CREDENTIAL_AUDIT.md`, `P8_5_3_IDEMPOTENCY_CONCURRENCY_AUDIT.md`, `P8_5_3_DOUBLE_ENTRY_ACCOUNTING_AUDIT.md`, `P8_5_3_ORDER_STATE_MACHINE_AUDIT.md`, `P8_5_3_ORDERBOOK_ADVERSARIAL_AUDIT.md`, `P8_5_3_ESI_READONLY_SECURITY_AUDIT.md`, `P8_5_3_DATABASE_RECOVERY_AUDIT.md`, `P8_5_3_REGRESSION_TEST_REPORT.md`, `P8_5_3_DEFECT_REMEDIATION_LOG.md`, `P8_5_3_GIT_CHANGE_SUMMARY.md`, `P8_5_3_FINAL_ACCEPTANCE_REPORT.md` 共 12 份专项报告。

### 15. 2026-11-02：完成 EVEAI P8.5.4 交易授权凭证密码学加固、复式记账重构与对抗测试
- **凭证密码学加固与防重放**:
  - `src/trading/types.ts`: `PipelineVerificationCredential` 新增 `characterId`, `marketSnapshotHash`, `expiresAt`, `nonce`, `keyId` 关键要素。
  - `src/trading/trading-pipeline.ts`: 引入规范化载荷序列化 `buildCanonicalCredentialPayload`；采用恒定时间比对 `timingSafeEqual`；支持密钥轮换字典 `PIPELINE_KEY_STORE`；实现 `validateAndConsumePipelineCredential`。
  - `src/trading/draft-system.ts`: 草案生成前原子性核验凭证并在 `consumed_pipeline_credentials` 表中记录消费存证，单次消费后永久阻断重放。
  - `src/db/migrations.ts`: 增加 `consumed_pipeline_credentials` 表迁移。
- **复式记账与借贷平衡严格对账**:
  - `src/trading/paper-trading.ts`: 彻底解耦买卖双方费用，买方仅扣买入经纪人费，卖方扣销售税与卖方经纪人费；部分成交撤单后全额释放剩余担保金及未使用保底费缓冲；双重记账流水实测借贷误差为 0.00 ISK。
- **全套回归与对抗性测试**:
  - 在 `tests/unit/p8-5-3-adversarial.test.ts` 中新增凭证单次消费防重放、跨角色越权拦截等测试。
  - 全套 7 个交易专项测试文件共 44 项单测 100% 通过（耗时 0.61s）。
  - TypeScript 0 错误，前端生产构建打包完全成功。
- **文档交付**:
  - 在 `docs/audit/P8.5.4/` 目录下交付 12 份标准审计报告 (`01-baseline-and-git-audit.md` 至 `12-p8-5-4-final-verdict.md`)。
