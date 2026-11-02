# P8.5.5 ESI 运行时只读安全审计

## 审计范围

检查：

- ESI catalog 生成与 policy 分类。
- callEsiOperation 是否在请求离开本地前执行白名单/身份/权限检查。
- HTTP method、URL、调用入口和 OAuth scope。
- Agent 工具是否暴露资产写接口。
- 通用 fetch 是否绕过 ESI 封装。

## 运行时入口

src/eve/esi-client.ts:57-103 callEsiOperation：

1. loadEsiCatalog。
2. operation 不存在则返回 404。
3. resolveAccess 检查 linked character、fresh capability snapshot、scopes 和 token。
4. prepareRequest 后才 fetchEsi。

测试：tests/unit/p8-5-5-esi-runtime-guard.test.ts:8

- 调用未知 operation post_markets_character_id_orders。
- stub global.fetch。
- 结果 status 404，fetchCalled false。
- 证明未知 ESI 操作在网络派发前被阻断。

## 发现的请求面

只读/查询：

- GET ESI universe、market、character assets、wallet、orders、contracts、skills 等。
- 少量 search 读接口可能使用 POST，但 catalog 通过 READ_ONLY_POST_OPERATIONS 标记。

非资产 UI 写操作：

- src/eve/route-planner.ts:870、885、922 调用 post_ui_autopilot_waypoint。
- src/telegram/handlers.ts:248、268 调用 post_ui_openwindow_*。
- src/discord/bot.ts:417、427 调用 post_ui_openwindow_*。

src/eve/esi-catalog.ts:218-222 将 ui namespace 分类为 toolPolicy='ui'，而不是 read。callEsiOperation 不拒绝 policy='ui' 或 'write'，executor 只做 side-effect dedupe。

## 资产写接口检查

没有发现以下资产写入口：

- create/cancel market order。
- transfer wallet ISK。
- contract create/accept。
- asset move。
- reprocess。
- fitting mutation 作为 Agent 工具。

scopes.ts 存在 write scopes 的定义，但未发现资产写业务调用。

## 结论

- 未知 ESI 操作会网络前阻断，有运行时测试。
- 没有发现真实市场订单、资产转移、合同、转账或再处理写路径。
- 但系统并非严格 HTTP 只读：UI POST 操作可达且 callEsiOperation 会派发。
- A23 的“零写接口”只能解释为零资产写工具，不能解释为零 ESI 写请求。

因此 ESI 运行时边界结论为 PARTIAL / UNVERIFIED。若验收规则要求严格只读 HTTP，则必须禁用或强隔离 post_ui_*，或把它们移出 read-only Agent 安全边界。
