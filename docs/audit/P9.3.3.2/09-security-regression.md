# 09 安全与业务边界回归

## ESI 只读

- 本地 ESI 元数据中 get_characters_character_id_wallet_transactions 只有 GET 方法，所需 scope 为 esi-wallet.read_character_wallet.v1。
- P9.3.3 钱包同步只调用该 GET 操作。
- 未修改 src/eve/esi-client.ts 的访问控制，也未新增 ESI 写操作、POST、PUT、PATCH 或 DELETE 能力。
- 应用层 POST /p9/3/esi-wallet-sync 是只读 ESI 证据同步的触发接口，不会向 ESI 写入数据。

## 身份与所有权

- 路由选择的 characterId 固定传入服务，服务不重新解析活动角色作为替代。
- 每个私有 ESI 请求前要求 fresh capability snapshot。
- Access Token 绑定的角色覆盖认证 ESI 请求的 character_id 路径参数。
- 角色解绑、所有权变化或租约丢失都会中止写入。
- SSO 所有权隔离代码未修改。

## 财务写入门禁

- REAL 账本仍区分 DRAFT、ACTIVE、VERIFIED 等状态。
- 钱包同步只建立 ESI 证据与待人工核实事实，不将钱包日志直接视为人工已核实成交。
- verify、reverse、correct、费用变更等人类责任操作仍由 assertHumanActor 限制为 user 或 user:<id>。
- AI、Agent、LLM 和 Scheduler 没有新增 REAL 财务账本写入路径。
- 数据库财务触发器和不可变事实保护未被删除、绕过或放宽。

## REAL/PAPER 隔离

- real_trade_records.is_paper 的数据库约束仍为 NOT NULL DEFAULT 0 CHECK (is_paper = 0)。
- P9.3 FIFO、账本汇总和钱包同步查询均限定 REAL 约束。
- 未修改 Paper Trading 表或流程，也未让 PAPER 结果进入 REAL 财务口径。

## UNKNOWN 与费用

- wallet transactions 不提供完整经纪人费和税费，因此同步记录保持 fee_status = UNKNOWN。
- 未知成本不会替换为 0；已实现盈亏、库存成本、资金占用和胜率按各自适用边界返回 null。
- 测试未放宽财务断言来制造通过结果。

## 未验证的安全边界

- 未在真实 EVE SSO 中执行 scope 撤销、Refresh Token 失效和跨设备角色切换。
- 未执行渗透测试、生产负载测试或真实数据库迁移演练。
