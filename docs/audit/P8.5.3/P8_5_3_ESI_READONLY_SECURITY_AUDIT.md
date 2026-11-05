# EVEAI P8.5.3：ESI 全链路只读安全与权限穿透审计报告 (P8_5_3_ESI_READONLY_SECURITY_AUDIT.md)

**完成日期**: 2026-11-02  
**审计范围**: 全代码库所有 ESI 端点、Agent 工具与 API 接口

---

## 一、十一项全链路只读权限核查

| 序号 | 检查对象 | 审查方法 | 实际核查结论 | 判定 |
|---|---|---|---|---|
| 1 | OAuth Scopes | 检查 `eve_accounts.scopes_json` | 存在写权限（如 `write_fleet`），但系统无对应写操作工具 | **建议收紧** |
| 2 | ESI API 封装 | 全文检索 `src/eve/esi-client.ts` | 仅实现 GET 方法读取资产、钱包、订单，0 POST/PUT 写接口 | **PASS** |
| 3 | 直接 HTTP 请求 | 全文检索 `fetch(` 调用 | 所有对外网络调用仅限只读接口与官方 SDE 下载，无游戏内交易调用 | **PASS** |
| 4 | Agent 工具注册表 | 检查 `src/agent/tools.ts` | 仅注册了本地只读 SQL 工具与 SDE 查询工具，0 写入工具 | **PASS** |
| 5 | 大模型工具调用权限 | 审查 `EffectiveToolRegistry` | 模型无任何权限触发向 EVE 客户端或 ESI 提交订单 | **PASS** |
| 6 | REST API 路由 | 审查 `src/web/api.ts` 与 `trading-routes.ts` | 仅操作本地 SQLite，无向 CCP 游戏服务器代理发送指令的接口 | **PASS** |
| 7 | 命令行 CLI | 审查 `scripts/eve-cli.ts` | 草案审批与手动记录仅修改本地数据库状态 | **PASS** |
| 8 | 后台定时任务 | 审查 `src/cron/` 与 Workers | 定时任务仅抓取公共行情与击杀邮件，无自动化套利交易 | **PASS** |
| 9 | 模拟盘沙盒隔离 | 审查 `src/trading/paper-trading.ts` | 虚拟订单与成交 100% 运行在 SQLite 内存/本地表，不产生网络外溢 | **PASS** |
| 10 | 真实 Token 防外泄 | 审查日志与模型上下文构建 | Token 密文加密存储，日志全局脱敏，严禁进入大模型 Prompt | **PASS** |
| 11 | 数据库副作用控制 | 审查事务写操作 | 仅记录历史机会日志、草案与虚拟账本，对真实资产 0 副作用 | **PASS** |

---

## 二、反向阻断测试实证

在 `tests/unit/p8-5-2-stress.test.ts` (Scenario R) 中通过静态源码断言：
- 代码库中严禁包含 `create_market_order`, `cancel_market_order`, `transfer_wallet_isk`, `trash_inventory_item` 等关键词。
- 证明系统在架构层面守住了“只读决策、人工执行”的安全铁律。
