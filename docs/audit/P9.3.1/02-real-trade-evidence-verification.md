# 真实交易证据验证报告

## 1. 真实环境样本状态

**已通过真实环境验证**

生产库角色 `2124784765` 的观测：

- 真实资产快照：`ASSETSNAP-1793694005368-cec3e526`，COMPLETED，483 items，176090 quantity。
- 真实资产估值：`ASSETVAL-1793694160630-ddaddae0`，COMPLETED，336 items valued，43 unknown。
- 钱包余额：17,577,460.97 ISK，最近同步 `2026-11-02 08:59:16`。
- `character_wallet_journal`：0 rows。
- `character_orders`：0 rows。
- `real_trade_records`：0 rows。
- `real_trade_evidence`：0 rows。
- 因此没有真实交易样本可用于人工登记、证据关联和交易核实。

**尚未验证**

- 真实 ESI 钱包交易导入。
- 真实钱包日志证据关联。
- 真实订单记录作为非充分证据的关联。
- 用户附件的真实人工核实流程。
- 真实重复记录检测。
- 真实交易冲正及历史重算。

## 2. 状态机代码验证

**已通过代码验证**

- 人工登记默认进入 `ACTIVE + USER_REPORTED`，不等于 VERIFIED。
- 草稿为 `DRAFT + PENDING`。
- 只有 `real_trade_records.record_state = VERIFIED` 且 `verification_status = VERIFIED` 才进入 FIFO。
- 核实要求至少一个同角色、状态 VERIFIED、关系 PRIMARY/CORROBORATING、且与交易事实类型和来源引用匹配的证据。
- 已核实或冲突证据存在时禁止交易核实。
- 公共证据登记固定为 PENDING，核实是独立人类操作。
- 已核实/冲正/更正记录不能删除或就地覆盖关键事实。
- 证据、费用及财务事件存在跨角色/孤儿关联阻断。

## 3. ESI 钱包交易接口能力

**已通过隔离测试数据验证**

- 使用 GET-only `get_characters_character_id_wallet_transactions`。
- ESI 响应字段 `unit_price` 已正确映射。
- 来源引用固定为 `esi-wallet:<transaction_id>`。
- 钱包交易同步只创建来源事实与证据，不自动核实交易。
- 费用完整性保持 `UNKNOWN`。
- 隔离测试验证：
  - `unit_price` 映射；
  - ESI 同步创建的记录仍为 `USER_REPORTED`；
  - 钱包证据来源引用不匹配时拒绝关联；
  - 匹配钱包证据仍需要明确的人类核实动作；
  - ESI_MARKET_ORDER / ESI_ASSET_SNAPSHOT 不能单独核实成交。

**尚未验证**

- 真实角色 ESI wallet transaction 全部分页导入。
- 真实钱包日志与交易记录的对应关系。
- 真实市场订单与钱包交易的证据匹配。
- 真实挂单不等于成交的拒绝路径。

## 4. 真实证据验证结论

**尚未验证**

当前没有真实交易样本。没有把隔离测试中的合成交易或测试证据写入 REAL 账本。真实交易证据闭环不能标记为通过，也不能推导真实交易绩效。

`REAL_ACCOUNTING_READY` 仍然成立，但 `REAL_ACCOUNTING_OPERATIONALLY_VERIFIED` 不成立。