# P8.5.6 ESI 运行时安全测试证据

测试文件：tests/unit/p8-5-6-esi-readonly-gateway.test.ts

| 测试 | 行号 | 断言 | 结果 |
|---|---:|---|---|
| UI POST 认证前阻断 | 12 | 405，fetchCalled=false | PASS |
| fetchEsiWithRetry 非 GET/跨 origin 阻断 | 35 | 405/403，fetchCalled=false | PASS |
| fetchWithTimeout 直接 ESI POST 阻断 | 61 | 405，fetchCalled=false | PASS |
| 明确登记 GET 放行 | 76 | GET 成功且 fetchCalled=true | PASS |

补充：tests/unit/p8-5-5-esi-runtime-guard.test.ts:11 验证未知 operation 在网络前返回 404。

绕过检查覆盖：

- callEsiOperation。
- fetchEsiWithRetry。
- fetchWithTimeout。
- fetchRetrying。
- DataCenter 原直接 fetch。
- 非 ESI URL 冒充 ESI helper。

结果：运行时绕过测试全部通过。
