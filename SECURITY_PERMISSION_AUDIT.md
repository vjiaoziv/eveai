# EVEAI 第二轮独立审计：安全机制与权限控制审查报告

**审计日期**: 2026-11-02  
**审计范围**: `src/auth/secret-storage.ts`, `src/eve/sso.ts`, `src/agent/tools.ts`, `src/trading/draft-system.ts`  
**审计结论**: **【已验证】(安全基线符合只读要求) / 【部分验证】(OAuth 作用域需收紧)**

---

## 一、八项安全指标核查矩阵

| 序号 | 审计项 | 源码实现位置 | 检查结果 | 评级 |
|---|---|---|---|---|
| 1 | ESI Token 密文存储 | `secret-storage.ts` L78 | 使用 AES-256-GCM 加密，12 字节随机 IV，独立 Auth Tag | **已验证** |
| 2 | 密钥与密文分离 | `secret-storage.ts` L20 | 生产环境强制要求外部环境变量 `AUTH_SECRET_KEY`，不入库 | **已验证** |
| 3 | 敏感凭证日志脱敏 | 全局日志管道 | 日志中对 access_token、refresh_token 进行截断与脱敏，无明文泄露 | **已验证** |
| 4 | Agent 工具只读限制 | `src/agent/tools.ts` | 仅注册了本地 SQL 查询、SDE 静态查询、公共行情汇总等只读工具 | **已验证** |
| 5 | 游戏写入能力阻断 | 全局代码库 | **完全没有**实现任何向 EVE ESI 提交订单、转账、弃置、销毁的写入工具 | **已验证** |
| 6 | REST API 绕过风险 | `src/web/api.ts` | 外部 API 路由无任何游戏资产写操作接口 | **已验证** |
| 7 | 交易草案审批隔离 | `draft-system.ts` L65 | 审批草案 (`status = 'approved'`) 仅修改本地 SQLite 数据状态，不触发任何网络交易 | **已验证** |
| 8 | OAuth Scope 最小化原则 | `src/web/auth-routes.ts` | 请求了包括 `esi-mail.send_mail.v1`, `esi-fleets.write_fleet.v1` 在内的多余写入 Scope | **部分验证** |

---

## 二、详细安全审计发现

### 1. 严格的人工交易屏障（Human-in-the-loop Guardrail）—— 表现优秀
- 代码库自始至终贯彻了“只读建议、人工执行”原则。
- `DraftSystem` 的状态流转仅限本地：
  `draft` $\rightarrow$ `approved` $\rightarrow$ `executed_manually`。
- 当玩家在网页点击“批准草案”时，后端仅执行：
  ```typescript
  db.prepare('UPDATE trade_drafts SET status = ? WHERE draft_id = ?').run('approved', draftId);
  ```
  没有调用任何 ESI 交易接口，资产安全底线得到物理级阻断。

### 2. OAuth Scope 权限过度申请警示
- 在玩家进行 EVE SSO 授权时，系统请求了 50+ 个 ESI Scopes。
- 其中包含了非只读的 Scope：
  - `esi-fittings.write_fittings.v1`
  - `esi-mail.send_mail.v1`
  - `esi-fleets.write_fleet.v1`
  - `esi-ui.open_window.v1`
  - `esi-ui.write_waypoint.v1`
- **风险**: 尽管 Agent 端未封装对应的工具，但过度申请写权限违背了安全最小特权原则（Principle of Least Privilege），若 Token 遭遇劫持将增加潜在受攻击面。
- **建议**: 在 EVE Developer Portal 与代码配置中移除不必要的写权限，仅保留 `read_assets`, `read_wallet`, `read_orders`, `read_skills` 等必要只读权限。
