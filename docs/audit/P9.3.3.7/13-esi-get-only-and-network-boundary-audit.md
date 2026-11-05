# 13 ESI GET-only 与网络边界审计

## 独立测试

`tests/audit/p9-3.3.7/network-and-safety-boundary-audit.test.ts` 直接读取 ESI catalog 并验证：

- catalog 中所有非 GET 操作被 `evaluateEsiOperationPolicy()` 拒绝为 405。
- `get_characters_character_id_wallet_transactions` 为 GET。
- 直接 `assertEsiHttpDispatch(..., 'POST')` 被拒绝。
- 非 `esi.evetech.net` origin 被拒绝。
- 通过 `fetchEsiWithRetry()` 使用 DELETE 在 fetch 之前被拒绝。
- 合法 GET 可以到达被 stub 的 fetch。
- 在拒绝场景下 fetch 调用次数为 0。

## 代码路径

- `src/eve/esi-security.ts`：非 GET、非 read policy、非配置 origin 的 fail-closed 策略。
- `src/eve/esi-client.ts`：网络 dispatch 前调用 `assertEsiHttpDispatch()`。

## 结论

本轮没有发现 ESI POST/PUT/PATCH/DELETE 绕过路径，也没有发现 P9.3.3.7 新增 ESI 写能力。Agent/LLM 工具面另有独立检查，未暴露 REAL 账本写工具。

## 限制

- 测试使用 fetch stub，不是真实网络抓包。
- 未使用真实 EVE token/账号，未验证代理、DNS、重定向或生产网关行为。
- 证据等级：代码验证 + 隔离测试数据验证；真实环境尚未验证。