# 17 REAL/PAPER 隔离与 ESI GET-only 回归

## 1. ESI 请求边界

测试：`tests/audit/p9-3.3.9/safety-boundaries.test.ts:45`。

验证：

- ESI catalog 中所有非 GET 操作在任何 fetch 之前被拒绝。
- POST、PUT、PATCH、DELETE 不因重试包装、直接 dispatch 或替代调用路径而绕过。
- 跨 origin 请求被拒绝。
- 失败发生在网络副作用之前。

结果：通过。

相关代码边界位于 `src/eve/esi-client.ts` 的 operation 校验、URL/origin 解析和 dispatch 路径。

## 2. REAL/PAPER 隔离

测试：`tests/audit/p9-3.3.9/safety-boundaries.test.ts:82`。

验证：

- 非人工 actor 不能修改 REAL 账本。
- REAL 记录不能被重新标记为 PAPER。
- PAPER 数据不能被提升进 REAL FIFO。
- 财务事实不可变触发器仍生效。
- 未通过放宽数据库触发器使测试通过。

结果：通过。

## 3. AI 工具面

测试：`tests/audit/p9-3.3.9/safety-boundaries.test.ts:131`。

扫描 native AI tool surface，未发现 REAL 财务 mutation 工具，例如：

- real-ledger mutation
- record real trade
- rebuild ledger
- real-trades
- inventory/lots mutation

结果：通过。

## 4. 与 F-P9339-01 的关系

F-P9339-01 是资产 snapshot/digest 的数据一致性缺陷，不削弱 ESI GET-only、REAL/PAPER 隔离或人工确认边界。但它会影响资产数据可用性，仍必须修复。

## 5. 结论

本轮未发现 ESI 写请求、REAL/PAPER 混写或 AI 自动修改 REAL 账本的新回归。

## 6. 证据等级

- 代码验证：已完成。
- 隔离测试数据验证：已完成。
- 真实环境验证：无。
- 尚未验证：真实网络中间层、生产代理、真实 SSO 权限和外部 ESI 行为。
