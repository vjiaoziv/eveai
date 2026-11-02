# P8.5.6 ESI GET 白名单与运行时安全网关

## 设计

新增 src/eve/esi-security.ts。

- evaluateEsiOperationPolicy：src/eve/esi-security.ts:26
- evaluateEsiHttpDispatch：src/eve/esi-security.ts:44
- assertEsiHttpDispatch：src/eve/esi-security.ts:63

规则：

1. 仅 method=GET。
2. 仅 toolPolicy=read。
3. URL 必须属于 ESI_BASE_URL 的 origin。
4. 未知 operation 在 catalog 查找阶段拒绝。
5. 最终 HTTP helper 必须再次检查。

## 接入点

- callEsiOperation 预检：src/eve/esi-client.ts:72
- fetchEsiWithRetry 最终出口：src/eve/esi-client.ts:381
- fetchWithTimeout：src/eve/http.ts:22
- fetchRetrying：src/eve/http.ts:71
- DataCenter ESI history 已改用受控 fetchWithTimeout：src/trading/data-center.ts

## 清单

可复现脚本：scripts/p8-5-6-esi-inventory.ts
原始输出：docs/audit/P8.5.6/logs/esi-inventory.json

| 指标 | 数量 |
|---|---:|
| catalog 总操作 | 58 |
| 允许 GET | 52 |
| 阻断非 GET | 6 |
| 阻断 UI POST | 3 |
| 非只读 GET | 0 |

6 个阻断操作包括 post_ui_autopilot_waypoint、post_ui_openwindow_information、post_ui_openwindow_marketdetails、post_universe_ids、post_universe_names、post_characters_affiliation。

结论：最终网络派发层严格 GET-only。
