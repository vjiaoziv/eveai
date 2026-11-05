# 回归与安全边界

## 1. ESI 只读

双重策略保持：

- `evaluateEsiOperationPolicy()` 拒绝非 GET 或非 read policy；
- `evaluateEsiHttpDispatch()` 在实际 fetch 前再次拒绝非 GET 和 ESI origin 之外的 URL。

资产同步调用 `get_characters_character_id_assets`，测试同时断言请求为 GET 且路径角色固定。没有新增任何 ESI POST/PUT/PATCH/DELETE 能力。

## 2. REAL/PAPER 隔离

资产同步只写：

- `character_assets` 只读资产 mirror；
- immutable asset snapshots/items/changes；
- sync job/lease/binding epochs。

它不创建 `real_trade_records`、fee、evidence link 或 FIFO fact，不自动核实交易，不把快照当成交，也不修改 Paper Trading 表。迁移中 REAL append-only/verification 和 PAPER 表保持分离；本阶段没有放宽任何财务触发器。

## 3. Agent 与真实交易边界

本轮只修改 read-only 资产同步协调和其测试。没有开放：

- 市场订单执行；
- 资产转移；
- ISK 转账；
- 合同创建；
- Agent 直接写 REAL ledger；
- 自动证据核实；
- 真实交易自动执行。

## 4. 历史机制回归

完整测试套件通过，覆盖以下既有保护：

- P9.3.3.1 F-01 至 F-07 反例；
- P9.3.3.2 钱包持久 lease、跨连接/多进程租约；
- 钱包失败队列和单调游标；
- 钱包交易严格类型、拒绝越过失败记录和幂等导入；
- 角色资料异常余额/资产响应保护；
- FIFO 已实现盈亏与未售出 UNKNOWN 分离；
- FIFO CURRENT/STALE/NEVER_CALCULATED；
- evidence/link 幂等和人工核实触发器；
- 角色权限、IDOR 与 active-character pin；
- 公共制品安全审计。

资产修复没有复用或削弱钱包租约；两类 lease 表独立，各自的 owner/generation/owner_id 语义保持隔离。

## 5. 迁移安全

迁移采用 `CREATE TABLE IF NOT EXISTS`、`addColumnIfMissing`、`CREATE INDEX IF NOT EXISTS` 和幂等 backfill/trigger 安装：

- 旧 job 新增 generation/owner/binding 列；
- 旧 snapshot 新增 hash algorithm/version；
- 历史重复 RUNNING job 先标记 FAILED 再安装唯一索引；
- binding epoch 先 backfill 再安装触发器。

迁移测试在隔离旧 schema 上连续执行两次并保持结果不变。生产数据库未迁移。

## 6. 安全结论

代码与隔离测试未发现 REAL/PAPER 穿越、ESI 写入扩大、旧角色数据越权写入或 Agent 财务写权限扩大。真实环境仍需独立审计。
