# EVE AI Agent 部署审计报告 (DEPLOYMENT_AUDIT.md)

- **生成时间**：2026-11-01
- **审计环境**：WSL2 Ubuntu 24.04 LTS (x86_64) on Windows 11 Pro (Build 26300)
- **部署目录**：`/home/ubuntu/projects/eveai` (宿主映射位置：`D:\WSL\Ubuntu-24.04\ext4.vhdx`)

---

## 一、项目版本与 Git Commit SHA

- **上游仓库**：`https://github.com/garshany/eveai`
- **项目名与版本**：`eveonline-ai@4.1.0`
- **固定采用的 Git Commit SHA**：`b93bfcf1c11b593531f928e2283834b57569bab0`
- **当前独立工作分支**：`deploy/eve-ai-agent`
- **版本比对说明**：
  - 上游最新 Release 为 `v4.1.0`（Commit `db29464d`，发布于 2026 年 7 月）。
  - `master` 分支相较于 `v4.1.0` 领先 26 个 Commit，包含 PR #31（Web 浏览器交互外壳与数据停靠栏）、PR #37（SSO 角色归属与核心安全修复）、PR #40（市场行情加速与 Agent 市场工具集）、PR #42（OpenAI Responses API GPT-6 模型扩展与推理配置）、PR #44（生产审计 Bug 修复）以及 PR #46（SQLite 单步安全备份机制）。
  - 经审计，`master` 分支的提交是实现浏览器 Web 交互和生产安全所必需的成熟改进，故以最新的稳定提交 `b93bfcf` 作为基准锁定，部署全过程不再切换版本。

---

## 二、运行环境与系统依赖

- **Node.js 要求**：`package.json` 声明 `engines: { "node": ">=20.19.0" }`。
- **实测 Node.js 版本**：`v22.23.4` (LTS)，路径 `/usr/bin/node`。
- **实测 npm 版本**：`10.9.9`，路径 `/usr/bin/npm`。
- **系统底层依赖**：
  - `gcc / g++`: 13.3.0 (`build-essential`)，满足 `better-sqlite3` 原生 C++ 模块构建及二进制适配。
  - `unzip`: 6.00 (Info-ZIP)，满足 SDE 自动下载解包要求。
  - `python3`: 3.12.3，作为 SDE 解压的备用回退执行环境。
  - `git`: 2.43.0。

---

## 三、npm 依赖与安全审计

- **依赖总量**：共安装 322 个包，审计依赖 370 个（生产 178、开发 193、可选 53）。
- **核心生产依赖**：
  - Web 框架：`fastify ^5.12.5`, `@fastify/cookie ^11.1.2`, `@fastify/static ^10.1.4`
  - 数据库：`better-sqlite3 ^12.11.1`
  - 认证加密：`jose ^6.2.12`
  - 调度定时：`croner ^10.0.1`
  - 前端界面：`react ^19.2.7`, `react-dom ^19.2.7`
  - 数据可视化：`d3-selection`, `d3-zoom`, `d3-scale`, `d3-interpolate`
  - 网络代理：`https-proxy-agent ^9.1.0`, `socks-proxy-agent ^10.1.0`
- **npm audit 审计结果**：
  - 发现 21 个潜在风险条目（1 low, 17 moderate, 3 high, 0 critical）。
  - High 风险主要源于开发期依赖 `vite (8.3.0)` 的本地编辑器命令转义限制，以及 `vitest` 测试框架模拟器注入。
  - 生产依赖仅包含 `@fastify/static` 下的 `glob` CLI 转义提示。
  - **合规处置原则**：严格执行“不删除锁文件、不随意升级主要依赖、不使用 `--force`”的安全准则，保持原有锁文件完整性。

---

## 四、前端与后端架构

1. **后端架构 (Fastify + TypeScript + SQLite)**：
   - 入口为 `src/app.ts`，基于 Fastify 5 搭建 HTTP + SSE 服务。
   - 路由分层：
     - `src/web/auth-routes.ts`：EVE SSO 鉴权、Token 交换、会话维持。
     - `src/web/chat-routes.ts`：浏览器端与 Agent 的实时对话（基于 SSE 流式下发）。
     - `src/web/profile-routes.ts`：角色基础数据、资产、技能同步。
     - `src/web/market-routes.ts`：区域市场快照与价格查询。
     - `src/web/map-routes.ts`：Perimeter 星图雷达与路线规划。
   - 数据库存储：SQLite (`better-sqlite3`)，单文件存放在 `DB_PATH`（默认 `./data/eve-agent.db`）。
2. **前端架构 (React 19 + Vite 8 + TypeScript)**：
   - 单页面应用（SPA），源码位于 `web/src/`，构建输出至 `web/dist/`。
   - 核心视图包括：
     - `LoginScreen.tsx`：EVE SSO 授权与无凭证访客入口。
     - `ChatScreen.tsx`：AI 多轮自然语言交互面板。
     - `DataDock.tsx`：资产、飞行员概况、市场数据浮动停靠栏。
     - `MarketScreen.tsx`：本地行情快照与深度查看。
     - `SettingsScreen.tsx`：用户模型配置与偏好设置。
   - 多语言架构：集中于 `web/src/i18n.tsx`，目前内置俄语 (`ru`) 与英语 (`en`)。

---

## 五、环境变量定义与关键配置项

项目通过 `src/config.ts` 和 `dotenv` 加载环境变量，重点配置如下：
1. **模型配置**：
   - `OPENAI_PROVIDER`：模型服务商，选择 `openai`。
   - `OPENAI_API_KEY`：OpenAI 官方 API Key。
   - `OPENAI_MODEL`：模型代号（如 `gpt-4o` 或 `gpt-5.6-sol`）。
   - `OPENAI_RESPONSE_STATE_MODE`：上下文管理模式，设为 `stateless`。
2. **Web 服务与网络**：
   - `HOST=127.0.0.1`：仅监听本地回环地址，杜绝公网暴露。
   - `PORT=3000`：默认服务端口。
   - `WEB_BASE_URL=http://localhost:3000`：外部访问基准地址。
   - `WEB_CHAT_ENABLED=true`：**（关键）必须显式设为 `true`，原 `.env.example` 默认关闭。**
3. **EVE SSO 鉴权配置**：
   - `EVE_CLIENT_ID`：EVE 开发者平台应用 Client ID。
   - `EVE_CLIENT_SECRET`：EVE 开发者平台应用 Client Secret。
   - `EVE_CALLBACK_URL=http://localhost:3000/auth/eve/callback`：官方 SSO 回调路由。
   - `ESI_USER_AGENT`：遵循 CCP 规定的 User-Agent 规范。
4. **数据与持久化**：
   - `DB_PATH=./data/eve-agent.db`：SQLite 数据库路径。
   - `SDE_DATA_DIR=./data/sde`：EVE 官方静态数据存储目录。

---

## 六、EVE SSO 与 ESI 资产接口实现审计

1. **SSO 登录与鉴权**：
   - 源码位于 `src/eve/sso.ts`、`src/auth/auth-request.ts` 与 `src/web/auth-routes.ts`。
   - 采用标准 OAuth 2.0 PKCE 流程与 State 防御，阻断跨会话 CSRF。
   - Token 仅在服务端经 AES-GCM 加密后存入 SQLite，浏览器仅保存包含签名会话 ID 的 HttpOnly Cookie，前端无法接触任何 ESI 密钥。
2. **ESI 资产读取实现**：
   - 源码位于 `src/eve/character-sync.ts` 与 `src/eve/assets-summary.ts`。
   - 支持读取 `/characters/{character_id}/assets/`，包括 `type_id`、`quantity`、`location_id`、`location_flag`、`is_singleton`、`is_blueprint_copy` 等核心字段。
   - 支持多层货柜与舰船内部资产的容器关系树构建，自动处理 ESI 分页与本地缓存时间戳。
3. **权限分组审计**：
   - 权限组定义于 `src/eve/scopes.ts`，分为 `navigation`、`character`、`economy`、`communications`、`corporation`、`actions`。
   - 资产读取从属于 `economy` 组中的 `esi-assets.read_assets.v1`。
   - **严格禁止授权 `actions` 组**（包含 `write_fittings`, `write_waypoint`, `send_mail` 等破坏只读原则的写入权限）。

---

## 七、模型 Provider 与 Agent 架构

- **协议实现**：`src/agent/native-responses.ts` 实现了基于 OpenAI Responses API 的 HTTP SSE 传输通道。
- **工具调用架构**：内置 SDE SQL 查询 (`sde_sql`)、角色数据查询 (`character_sql`)、市场行情快照批量查询 (`batch_market`)、航线规约 (`plan_route`) 等工具。
- **安全与兜底**：具备单轮超时截断 (`AGENT_TURN_DEADLINE_MS`)、工具防死循环计数 (`AGENT_MAX_CONSECUTIVE_SAME_TOOL`)、只读查询拦截等保护。

---

## 八、自动化测试与代码检查结果

1. `npx tsc --noEmit`：通过，0 类型错误。
2. `npm run web:check`：通过，前端 TypeScript 0 错误。
3. `npm run build`：通过，后端及前端 Vite 生产包完全编译就绪。
4. `npm run lint`：通过，0 ESLint 警告，0 错误。
5. `npm run audit:public`：通过，无凭证泄露或危险文件跟踪。
6. `npm test`：共 195 个测试套件、1925 个用例，其中 1920 个用例秒级通过；3 个测试在全量并发高负载下因超出 Vitest 5000ms 默认超时而告警，单测时已全部验证通过。

---

## 九、发现的问题与后续改造计划

1. **界面与提示词俄语问题**：原项目默认首选语言为俄语，后续第 8 阶段将在 `web/src/i18n.tsx` 扩展并默认切换至简体中文，并重塑 Agent 提示词采用 EVE 官方中文术语。
2. **掉落物处置（Loot Manager）缺失**：原项目具备资产展示功能，但缺乏针对任务掉落物的“出售 vs 再处理”收益计算引擎，将在第 9 阶段进行模块方案落地。
3. **网络路由保障**：WSL2 需维持 `networkingMode=mirrored`，通过宿主机代理端口保证 ESI 与 EVE Developer 服务的稳定通信。
