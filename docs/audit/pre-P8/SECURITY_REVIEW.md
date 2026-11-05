# EVE AI Agent 安全审计与防护审查报告 (SECURITY_REVIEW.md)

- **审查对象**：EVE AI Agent (`garshany/eveai`, Commit: `b93bfcf1c11b593531f928e2283834b57569bab0`)
- **审查日期**：2026-11-01
- **执行环境**：WSL2 Ubuntu 24.04 LTS (x86_64) on Windows 11 Pro

---

## 核心安全指标审查（12 项全要素）

| 序号 | 检查项目 | 源码实现位置与机制 | 审查结论与防护状态 |
| :--- | :--- | :--- | :--- |
| **1** | **API Key 服务端隔离** | `src/config.ts`, `src/openai-provider.ts`<br>API Key 仅通过 Node.js 进程环境变量读取，构建产物 (`web/dist/`) 中绝无任何 API Key 注入。前端代码仅通过 `/api/web/chat` 与服务端通信。 | **合格 (隔离完整)**<br>客户端/浏览器无法通过任何逆向手段提取模型密钥。 |
| **2** | **EVE Token 强加密存储** | `src/auth/secret-storage.ts`, `src/auth/auth-request.ts`<br>EVE OAuth 刷新令牌 (Refresh Token) 在写入 SQLite `eve_accounts` 表前，必须经过基于 AES-GCM 的硬件/密钥派生加密，密文入库。 | **合格 (加密落盘)**<br>即使数据库文件泄露，无主密钥亦无法解密 EVE Token。 |
| **3** | **本机安全网络策略** | `src/config.ts`<br>`HOST=127.0.0.1` 默认绑定，仅限本地回环。未开启任何未经鉴权的公网穿透；WSL 采用镜像网络，宿主机直接访问 `127.0.0.1:3000`。 | **合格 (零公网暴露)**<br>杜绝了未授权的外部网络探测与非法访问。 |
| **4** | **CSRF 深度防御体系** | `src/web/security.ts`, `src/web/auth-routes.ts`<br>所有跨站请求（包括 SSO Callback 和 POST 接口）必须携带强随机校验参数。前端请求携带由 Cookie 派生且加密比对的 `x-csrf-token` 请求头。 | **合格 (全链路防护)**<br>阻断了跨站恶意诱导授权或恶意调用的可能。 |
| **5** | **安全 Cookie 策略** | `src/web/web-session.ts`, `src/web/server.ts`<br>会话 Cookie 严格标记 `HttpOnly; SameSite=Lax; Path=/`。前端 JavaScript 脚本完全被浏览器沙箱隔离，无法读取 Cookie 原始内容。 | **合格 (符合安全基线)**<br>有效防御 XSS 盗取身份凭据。 |
| **6** | **SSO 登录与所有权保护** | `src/web/auth-routes.ts` (PR #37 专项加固)<br>登录流程具备角色所有权哈希验证。当角色在游戏内转让或被其他账号买入时，系统自动识别归属权变更，阻断旧会话越权冒用。 | **合格 (防冒领/防越权)**<br>杜绝了多账户或角色交易后的越权访问。 |
| **7** | **请求频率速率限制** | `src/web/web-admission.ts`, `src/config.ts`<br>具备多级滑动时间窗口限制器（如 `WEB_REQUEST_WINDOW_SECONDS=60`、`WEB_MAX_REQUESTS_PER_USER_WINDOW=6`），超出阈值立即优雅排队或熔断。 | **合格 (高频过载保护)**<br>防止恶意刷量或并发打满本地资源。 |
| **8** | **模型调用开销与预算限制** | `src/agent/native-responses.ts`, `src/usage/`<br>单轮对话强制设定最大工具迭代次数 (`AGENT_MAX_TOOL_ITERATIONS=80`)、输出字符上限与最大执行时长 (`AGENT_TURN_DEADLINE_MS=600000`)。 | **合格 (防模型账单失控)**<br>杜绝了死循环调用或无限 Token 消耗。 |
| **9** | **Agent 工具危险性评估** | `src/agent/tools.ts`<br>当前注册工具均为只读分析类：`sde_sql`（只读 SQL）、`character_sql`（只读本地同步表）、`batch_market`（查询订单）、`plan_route`（航线计算）。 | **合格 (零写操作工具)**<br>无任何执行转账、改配、丢弃或修改游戏资产的工具。 |
| **10** | **提示词注入 (Prompt Injection) 防护** | `src/agent/prompts.ts`, `src/agent/executor.ts`<br>系统级指令将不可信外部数据包裹于 `<runtime_context_data>` 内部，并使用统一前缀标记为只读数据；任何外部输入均无法提权调用未授权工具。 | **合格 (结构化边界隔离)**<br>有效防止通过聊天诱导提取系统密钥或越权。 |
| **11** | **日志敏感信息过滤** | `scripts/public-artifact-audit.sh`, `src/observability/`<br>日志输出器自动执行脱敏；`npm run audit:public` 扫描确保日志、异常抛出中不打印带有 `sk-`、Token 或私钥的内容。 | **合格 (无密钥回显)**<br>终端与控制台均无敏感明文暴露。 |
| **12** | **数据库备份与灾备恢复** | `src/db/sqlite.ts`, PR #46 单步原子备份机制<br>支持 SQLite 运行时一致性原子快照备份，避免热备份文件损坏，保留多代版本回退能力。 | **合格 (具备完整灾备)**<br>支持快速导出与无损恢复。 |

---

## 结论
经静态与动态架构审计，本项目当前在密钥生命周期、ESI 访问边界、Cookie 安全、会话管理以及 Agent 工具调用范围上均符合严格的安全基线要求，无已知未处理的高危安全隐患。
