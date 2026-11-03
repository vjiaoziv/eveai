# P9 Security Report

## 不可突破边界

P9 不提供：

- 真实市场买单 API
- 真实市场卖单 API
- 撤单 API
- 转账、资产转移、合同、再处理 API
- UI 自动下单入口
- Agent/MCP 自动真实执行入口

真实资产操作只能由用户在 EVE 客户端完成。

## 网络只读拦截

保留 P8.5.6：

- `src/eve/esi-security.ts`
- `src/eve/http.ts`

`fetchWithTimeout` 和 `fetchRetrying` 在网络派发前对 ESI origin 执行：

```text
method === GET
```

否则抛出错误，不依赖前端按钮或业务层权限。

P9 新增同步操作：

`get_characters_character_id_wallet_transactions`

Swagger 方法为 GET，catalog policy 通过。

## AI 安全

`src/trading/p9-ai-analysis.ts`：

- 只发送数据库确定性字段。
- 禁止重新计算利润。
- 要求引用 opportunityId、snapshotId、dataTime。
- UNKNOWN 不得转成 0。
- 禁止输出 `REAL_TRADING_READY`。
- 不把 Paper 收益描述为真实盈利。

AI 请求经过 Web admission、CSRF/会话 guard 和 usage 记录。

## 密钥

API 密钥、ESI token 只保存在服务端环境/数据库，不进入前端 bundle。

## 测试

`tests/unit/p9-safety-and-ai.test.ts`：

- GET ESI 允许
- POST ESI 在网络边界阻断
- 非 ESI origin 不绕过校验
- wallet transactions 为 GET
- AI prompt 含硬限制

P8.5.6 的 ESI runtime guard、并发、凭证和账本安全测试全部保留。