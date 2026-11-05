# 08 REAL/PAPER 与 ESI 只读安全边界

## 1. ESI GET-only

双层保护：

1. 操作目录策略 src/eve/esi-security.ts:26-42：
   - method 必须为 GET；
   - toolPolicy 必须为 read；否则 405/403。
2. 最终 HTTP 派发 src/eve/esi-security.ts:44-65：
   - URL 必须属于配置的 ESI origin；
   - method 必须为 GET；
   - fetchRetrying 在发起 ESI 请求前调用 assertEsiHttpDispatch。

测试 tests/unit/p8-5-6-esi-readonly-gateway.test.ts 验证：

- UI POST 在任何认证/网络派发前被拒绝；
- 最终 fetch helper 拒绝非 GET；
- 拒绝 ESI origin 外请求；
- 直接 fetchWithTimeout POST 被拒绝；
- 显式注册的 GET 可以通过。

SSO token endpoint 的 POST 与外部 Eve Scout POST 不属于 ESI 业务派发层，未被本结论混同。

## 2. REAL/PAPER 隔离

数据库层：

- real_trade_records 对 is_paper 有约束；
- 真实交易触发器禁止直接删除和原地覆盖关键事实；
- 插入/更新为 VERIFIED 必须经过核实流程；
- VERIFIED 不可降级；
- FEE_ADJUSTMENT 在口径未定义前不可核实；
- 核实要求匹配证据关联；
- real_trade_evidence_links 触发器阻止跨角色关联。

服务/API 层：

- 钱包同步使用 ESI_SYNC actor，只创建待核实交易和证据；
- Agent actor 被 assertHumanActor 拒绝；
- P9.3 路由使用 requireMutationSession 并解析服务端 linkedCharacter；
- FIFO 查询显式限制 is_paper = 0 和 VERIFIED/VERIFIED；
- Paper 收益不能进入 REAL performance。

## 3. 钱包同步不等于人工核实

钱包同步 evidence 的 VERIFIED 状态只表示来源证据可信。交易事实仍：

~~~text
同步创建：DRAFT / PENDING
同步提交：ACTIVE / USER_REPORTED
人工核实：VERIFIED / VERIFIED
~~~

FIFO 只处理最后一种。

因此钱包日志不能自动成为真实成交确认，也不能自动进入财务盈亏。

## 4. 权限与 IDOR

- 所有 P9.3 REAL 财务路由先 requireSession/requireMutationSession；
- 角色来自服务端 linkedCharacter，不接受客户端任意 characterId 作为财务查询目标；
- 服务层查询普遍附带 character_id；
- 证据关联服务要求 record 和 evidence 同属当前角色；
- 数据库触发器再次校验跨角色关联。

隔离测试覆盖未授权 scope、角色切换、解绑、所有权变化和跨角色证据关联。

## 5. 未验证边界

- 生产 IAM/Session 失效传播；
- 真实 OAuth 撤销；
- Agent 工具目录在生产配置中的实际暴露；
- Scheduler 部署实例是否完全禁用真实财务写入口；
- 真实市场订单、资产转移和合同接口的外部边界。

本轮未发现 REAL/PAPER 或 ESI GET-only 被削弱，但不能据此声称生产环境已操作验证。
