# 06 安全与业务边界

## ESI 请求

- src/eve/esi-security.ts 的操作策略要求 operation.method 严格等于 GET，且 toolPolicy 严格等于 read。
- HTTP 分发层再次检查规范化方法必须为 GET，否则返回 405。
- fetchWithTimeout 与 fetchRetrying 对配置的 ESI origin 都执行分发层检查，阻止网关绕过。
- 本阶段钱包同步只调用 get_characters_character_id_wallet_transactions，资产同步只调用 get_characters_character_id_assets。
- 未增加 POST、PUT、PATCH 或 DELETE ESI 能力。
- 路由层 /esi-wallet-sync 是应用内 POST 动作，但它发出的 ESI 请求仍是 GET。

## REAL/PAPER 隔离

数据库层继续保证：

- real_trade_records.is_paper INTEGER NOT NULL DEFAULT 0 CHECK (is_paper = 0)。
- P9.3 REAL 表与既有 PAPER 表分离。
- FIFO 查询持续带 is_paper = 0。
- 本阶段未修改或放宽任何既有财务触发器。
- 新增数据库对象限于钱包同步失败记录、角色级租约、资产 lineage/binding fencing 和相应索引。

## 财务不可变性

保留并复核以下约束：

- REAL 交易记录禁止直接删除。
- 非 DRAFT 交易事实禁止原地覆盖。
- 交易必须先登记再核实，不能插入即 VERIFIED。
- DRAFT 必须提交为待核实申报后才能核实。
- VERIFIED 不可降级；只能通过 REVERSED 或 CORRECTED 流程表达变化。
- FEE_ADJUSTMENT 未定义安全归属时不可核实。
- 核实交易必须存在匹配的已核实 ESI 或资产证据。
- 冲突证据阻止核实。
- 财务事件日志只允许追加。
- 已核实证据不可修改。

## AI/Agent/Scheduler 边界

人工复核 src/agent 和 src/scheduler：

- 未发现 P93LedgerService、real_trade_records 或 real_fifo_* 的直接写入调用。
- AI、Agent 和 Scheduler 未获得 REAL 财务账本修改能力。
- 网页写操作仍要求 mutation session 和 CSRF 校验。

## 证据与人工核实分离

钱包同步自动创建：

- DRAFT REAL 交易记录；
- ESI 钱包证据；
- 证据关联。

钱包同步不等于交易已人工核实。交易进入 FIFO 仍需用户执行提交、证据核实和人工核实流程。

## UNKNOWN 与业务语义

- 未知成本不回退为 0。
- UNKNOWN 已售成本不进入确定性已实现盈亏。
- 未售出 UNKNOWN 影响库存成本和资金占用，但不污染已完成卖出的确定性盈亏。
- 订单不等于成交。
- 资产快照不等于成交。
- 钱包日志同步不等于人工核实。
- 没有新增真实交易自动执行。

## 最终验证

- 代码层边界复核通过。
- 隔离测试中的 GET-only、身份隔离、REAL/PAPER 和财务触发器回归通过。
- 没有执行生产 ESI、生产数据库、生产部署或真实交易。

## 缓存与快照完整性补充

- 钱包同步在完成能力快照、scope、角色绑定和所有权检查后，对 ESI 钱包分页使用 bypassCache: true。该选项只拒绝复用可能属于旧所有权上下文的响应，不绕过 ESI GET-only、origin、超时、重试、分页或身份 fencing。
- 所有权转移回归验证：新所有者不会继承旧所有者的钱包缓存响应，且使用独立游标导入较低 transactionId 100；旧所有者保留 transactionId 101。
- 资产概览完整性判定同时要求 hash_algorithm、canonical_version、当前镜像规范哈希和快照 data_hash 匹配；相同聚合计数但不同明细集合报告 INCONSISTENT。快照详情使用显式分页，避免把截断结果展示为完整快照。
- 上述修复不改变 REAL/PAPER 隔离、财务触发器、人工核实边界或 ESI GET-only 策略。
