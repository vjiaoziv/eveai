# 06. Agent、Scheduler、前端与权限边界

## 审计范围

- `src/agent/`
- `src/scheduler/`
- `src/web/p9-3-routes.ts`
- `src/web/p9-routes.ts`
- `web/src/components/P93AccountingPanel.tsx`
- `web/src/components/P9TradingScreen.tsx`
- `src/eve/esi-security.ts`
- 相关测试

## ESI 读取边界

### 已通过代码验证

- `evaluateEsiOperationPolicy()` 只允许 `method === 'GET'` 且 `toolPolicy === 'read'`：`src/eve/esi-security.ts:26-42`。
- 底层 HTTP 分派也拒绝非 GET：`:44-65`。
- `callEsiOperation()` 在发起网络前执行 operation policy：`src/eve/esi-client.ts:72-80`。
- 重复缓存只对 GET 生效：`:95-99`。
- 没有发现 P9.3 钱包同步路径调用 POST/PUT/PATCH/DELETE ESI。

结论：本轮源码层面确认 ESI GET-only 边界未被削弱。

## Agent 与 Scheduler

### 已通过代码检索和测试验证

- `src/agent/`、`src/scheduler/` 未发现直接引用 `P93LedgerService`、`real_trade_records` 或 `esi-wallet-sync` 的写路径。
- `P93LedgerService` 的 `USER` actor 路径和 `ESI_SYNC` actor 路径有明确限制：
  - AI/Agent/LLM 类 actor 被拒绝。
  - 公共人工入口不能伪造 ESI/资产变化来源。
  - ESI 同步身份只允许 `esi-wallet-sync`。
- `tests/unit/p9-3-hardening.test.ts` 验证：
  - 公共调用者不能伪造 ESI 证据。
  - 非人工 actor 身份被拒绝。
  - 已核实记录不能被降级。
  - 直接 SQL 修改财务事实会失败。
- `tests/unit/p9-3-real-accounting.test.ts` 验证：
  - REAL 与 PAPER 隔离。
  - AI mutation actor 被拒绝。
  - 已验证记录和审计事件保护。

### 审计说明

这是源码/隔离测试层面的验证，不是对实际运行中的 Agent 动态调用图或 Scheduler 调度器的穷尽证明。未启动生产 scheduler，未执行真实 ESI 账号操作，未进行 Agent 运行时审计日志抓取。

## 钱包同步的安全语义

当前实现：

- 钱包同步需要认证会话、mutation session 和目标角色链接。
- 私有 ESI 需要新鲜能力快照及 `esi-wallet.read_character_wallet.v1`。
- 同步只读取 ESI，不创建订单、不转账、不调用真实交易执行。
- 同步记录写入 `ACTIVE/USER_REPORTED`，不会自动变成 `VERIFIED`。
- 证据可来自 ESI 只读钱包日志，但交易必须人工核实后才可能进入 FIFO。

未发现自动真实交易执行或 Agent 直接修改 REAL 账本的路径。

## 前端 REAL 财务展示

### 已通过代码验证

- `P93AccountingPanel` 总览页展示 freshness 状态和警告：`web/src/components/P93AccountingPanel.tsx:244-260`。
- P9.3 专用 performance API 返回 `P93FifoService.performance()`，包含 `freshness`：`src/web/p9-3-routes.ts:110-119`、`349-355`。
- 前端不能仅靠隐藏按钮作为权限控制；关键写路由还要求 mutation session 和后端角色归属检查。

### F-06（P2）不是所有 REAL 盈亏界面都展示 freshness

问题位置：

- `web/src/components/P93AccountingPanel.tsx:426-445`：`pnl` 页直接显示指标，没有 freshness 警告。
- `src/web/p9-routes.ts:199-247`：兼容 overview 没传 `freshness`。
- `web/src/components/P9TradingScreen.tsx:320-322`、`:533-544`：显示 REAL 已实现/未实现盈亏，但没有 freshness 提示。

影响：

- 旧 FIFO 结果在部分页面看起来仍像当前结果。
- 用户可能基于过期盈亏做决定。
- 违反“STALE 不得显示为 CURRENT”的目标。

建议：

- 兼容 API 返回 `performance.freshness`。
- 所有 REAL 财务展示组件统一读取该字段。
- `STALE`、`NEVER_CALCULATED`、失败重算分别使用明确文案。
- 在非 CURRENT 时禁止使用“当前完整结果”措辞；保留旧值但标注过期。

## IDOR、跨角色和废弃 API

- P9.3 路由使用当前 session 的 linked character，并在服务中固定角色。
- `P93AccountingPanel` 的账本路由从 session 取角色，不从 URL 直接接受 characterId。
- 兼容 overview API 同样从 session 解析角色：`src/web/p9-routes.ts:199-203`。
- 未发现本轮新增的跨角色 IDOR 路径。
- 旧兼容 API 的 freshness 缺失属于状态展示缺陷，不是身份隔离缺陷。

## 验证边界

### 已通过代码验证

- ESI GET-only 双重拦截。
- REAL/PAPER 数据库与服务约束。
- Agent 无法通过公开人工入口伪造 ESI 来源。
- 前端总览存在 freshness 展示。

### 已通过隔离测试数据验证

- 权限、REAL/PAPER、AI actor、证据伪造、直接 SQL 保护。
- 钱包路由缺少 scope、角色切换、解绑、分页失败。

### 尚未验证

- 生产浏览器实际页面。
- 真实 Scheduler 触发和并发。
- 真实 Agent 在执行器中的动态工具选择。
- 真实 EVE SSO scope 变更后的用户操作链路。