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
