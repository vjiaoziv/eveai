# 安全边界验证报告

## 1. 信任边界

**已通过代码验证**

本轮检查了以下边界：

- 浏览器 Cookie/CSRF → Fastify 会话路由。
- EVE SSO 回调 → `auth_requests`、`web_sessions`、角色绑定。
- 模型输出 → Agent 工具白名单与参数校验。
- Agent/同步任务 → SQLite 与 REAL 财务账本。
- ESI 客户端 → 外部 EVE API 的最终网络派发。
- 公共市场/杀敌数据 → 市场、地图和情报工具。
- REAL 账本 / PAPER 账户 → 前端与统计接口。
- SQLite 迁移/触发器 → 财务事实不可逆边界。
- 文件、日志、静态资源和错误响应 → 浏览器可见面。

## 2. 认证、Cookie、CSRF 与会话

**已通过隔离测试数据验证**

- 会话 Cookie 为 `HttpOnly`；CSRF Cookie 需要前端读取，因此 `HttpOnly=false`，并设置 `SameSite=strict`。
- 生产 HTTPS 模式下安全 Cookie 受 `webCookiesAreSecure()` 控制。
- 所有写操作要求 CSRF 头，服务端比较受保护的 CSRF hash。
- 会话有创建窗口限流、过期清理和主动撤销。
- SSO 回调绑定请求会话，避免跨会话回调注入。
- 测试覆盖：`web-security.test.ts`、`web-security-tier.test.ts`、`web-session-revocation.test.ts`、`web-session-timestamps.test.ts`。

**已通过真实环境验证**

- `/app` 返回 302 到 canonical `/app` 后 200，响应设置 CSP、`X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、权限策略等安全头。
- 未认证 `/api/web/session` 返回 `{"session":null,"ssoConfigured":true,...}`，不泄露角色数据。
- 4 个未认证 REAL 路由均返回 401。

**尚未验证**

- 部署后重新完成一次完整 EVE SSO 登录往返。
- 多用户并发登录、真实 Cookie 过期和浏览器端会话撤销的全链路浏览器测试。

## 3. REAL/PAPER 隔离

**已通过隔离测试数据验证**

- REAL 交易使用 `real_*` 表；PAPER 使用 `paper_*` 表，无共享账户/成交表。
- Paper 读接口不自动创建账户，避免读请求产生副作用。
- REAL 统计只读取 REAL 已核实事实和派生表。
- 旧 P9 REAL 兼容接口保持 410 或受保护状态。
- 相关测试：`p8-7-paper-role-isolation.test.ts`、`paper-routes-isolation.test.ts`、`p9-3-real-accounting.test.ts`。

**已通过真实环境验证**

生产库当前：

- `real_trade_records = 0`
- `real_trade_events = 0`
- `real_trade_evidence = 0`
- `real_fifo_lots = 0`
- `real_fifo_consumptions = 0`
- `paper_trading_accounts = 1`
- `paper_trading_orders = 0`
- `paper_fills = 0`

没有证据表明 PAPER 数据进入 REAL 财务表。

## 4. REAL 账本写入权限

**已通过隔离测试数据验证**

- REAL 账本写入只接受人工 `user:<id>` actor。
- AI、system、scheduler、同步任务均不能写 REAL 账本。
- AI `set_autopilot=true` 被阻断。
- 草稿不能直接核实；已核实记录不能无痕降级或删除。
- 证据核实需要独立人工操作；同一 ESI 证据不能支持多条交易。
- 相关测试：`p9-3-hardening.test.ts`、`p9-safety-and-ai.test.ts`、`p9-3-real-accounting.test.ts`。

**尚未验证**

- 真实人工在生产界面登记、关联证据、核实、冲正的完整浏览器闭环；本轮遵守只读约束，没有执行该写流程。

## 5. ESI GET-only

**已通过隔离测试数据验证**

- 最终网络派发网关强制只允许 GET。
- 钱包、订单、资产、角色和公共数据同步共享该边界。
- 路由调用方不能通过直接注入 URL 或自定义 method 绕过最终网关。
- 测试覆盖：`p8-5-6-esi-readonly-gateway.test.ts`、`esi-client.test.ts`、`p9-3-hardening.test.ts`。

**已通过真实环境验证**

- 资产、市场、飞行员档案使用实际 ESI/公开数据页面读取；未观察到写请求路径。
- 生产启动日志显示 asset-sync、market worker、Perimeter feed 运行；没有执行自动交易。

**尚未验证**

- 真实 ESI 钱包权限下的钱包日志/成交同步；当前 `character_wallet_journal = 0`、`character_orders = 0`、`real_esi_transaction_sync = 0`。

## 6. SQL 注入、XSS、SSRF、文件与错误泄露

**已通过隔离测试数据验证**

- SDE/角色 SQL 工具使用只读、受限查询路径，拒绝危险语句。
- Markdown 渲染使用受控组件，外部链接与 HTML 风险有专门测试。
- 外部 URL/图片/抓取路径有 SSRF 和协议/主机约束。
- 静态文件服务仅暴露 `web/dist`，未开放数据目录。
- API 错误不返回 SQL、文件路径、token 或内部堆栈。
- 测试覆盖：`character-sql-security.test.ts`、`sde-sql-security.test.ts`、`web-security.test.ts`、`web-security-tier.test.ts`、市场 AI 路由测试。

**尚未验证**

- 第三方安全扫描工具未能运行，原因见第 8 节；因此不能声称已获得完整自动化 SAST/DAST 覆盖。

## 7. 依赖与供应链

**已通过真实环境验证**

- 最终 `npm audit --omit=dev`：`found 0 vulnerabilities`。
- 已升级直接/间接依赖：Fastify `5.12.8`、`@fastify/static` `10.1.8`、`@fastify/cookie` `11.1.5`、discord.js `14.28.0`、jose `6.2.15`、undici `6.29.1`、glob `14.0.3`。
- 未使用 `npm audit fix --force`，未采用破坏性强制升级。
- 完整测试和构建在升级后通过。

**已通过代码验证**

- 初始审计中的 undici、`@fastify/static`、glob/minimatch、fast-uri、ip-address 风险已按依赖树处理；没有保留已知 audit 告警。

## 8. 安全扫描工具状态

**尚未验证**

Codex Security 扫描工具在本环境不可用，错误为：

```text
Could not read local file: node_modules\.bin\acorn
```

因此本轮不能声称“安全扫描已通过”。替代证据为：依赖审计、静态代码审查、迁移/触发器核验、认证/CSRF/会话专项测试、SQL/ESI/AI 写入边界测试以及生产只读 HTTP 检查。
