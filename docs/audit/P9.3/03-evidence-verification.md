# P9.3 交易证据与核实规则报告

## 证据类型

支持 `ESI_WALLET_LOG`、`ESI_MARKET_ORDER`、`ESI_ASSET_SNAPSHOT`、`ASSET_CHANGE`、`USER_ATTACHMENT`、`USER_CONFIRMATION`。

每条证据包含来源系统、来源引用、采集时间、内容哈希、摘要、元数据和状态。相同 `source_system + source_ref` 的证据必须哈希一致，否则拒绝覆盖。

## 核实等级

- VERIFIED：有足够证据支持交易事实。
- USER_REPORTED：用户申报，缺少充分独立证据。
- PENDING：存在待核查信息。
- CONFLICT：证据冲突。
- REJECTED：记录错误或无效。

## 关系

证据与交易通过 `real_trade_evidence_links` 关联，关系包括 PRIMARY、CORROBORATING、CONFLICTING、ADJUSTMENT。

只有 VERIFIED 证据的 PRIMARY/CORROBORATING 关联，才能把交易提升为 VERIFIED。用户手动录入本身只能是 USER_REPORTED。

## 禁止推断

- 资产快照出现某物品，不等于市场购买。
- 钱包 ISK 变化，不等于某笔交易的费用或收入。
- 资产数量变化不会自动生成已核实买卖交易。
- 任务奖励、NPC 掉落、合同、制造、再处理、装配和转移保留为资产变化/UNKNOWN_SOURCE 复核案例。