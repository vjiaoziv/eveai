# P8.5.5 费用模型独立复核

## 官方来源

查询日期：2026-11-02。

EVE Online Support - Broker Fee and Sales Tax：

https://support.eveonline.com/hc/en-us/articles/203218962-Broker-Fee-and-Sales-Tax

官方摘要：

- NPC broker fee 起点 3%。
- Broker Relations 每级减少 0.3%。
- NPC station formula：3% - 0.3% * BrokerRelationsLevel - 0.03% * FactionStanding - 0.02% * CorpStanding。
- NPC broker fee 下限 1%。
- Sales tax 起点 7.5%，Accounting 可降至约 3.37%。
- Upwell structure broker fee 由结构设置；0.5% 作为 NPC SCC sink，Broker Relations 不适用于 Upwell。

## 代码模型

src/trading/fee-engine.ts:5-14：

- BASE_SALES_TAX_RATE = 0.075。
- ACCOUNTING_REDUCTION_PER_LEVEL = 0.11。
- NPC_BASE_BROKER_FEE_RATE = 0.03。
- BROKER_RELATIONS_REDUCTION = 0.003。
- FACTION_STANDING_REDUCTION = 0.0003。
- CORP_STANDING_REDUCTION = 0.0002。
- NPC_BROKER_FEE_FLOOR = 0.01。
- STRUCTURE_BROKER_FEE_FLOOR = 0.005。
- STATUTORY_SCC_SURCHARGE_RATE = 0.005。
- MINIMUM_BROKER_FEE_ISK = 100。

## 重算测试

- A20：Upwell broker fee 与 SCC surcharge 独立计算，没有重复扣除。tests/unit/p8-5-5-a01-a24.test.ts:377。
- A21：微小订单买方和卖方 broker fee 均达到 100 ISK 保底。tests/unit/p8-5-5-a01-a24.test.ts:400。
- 全部 A01-A24 中费用相关测试通过。

## 发现

1. 官方来源支持 7.5% 销售税、3% NPC broker 基础费率、技能/声望公式、1% NPC 费率下限和 Upwell 0.5% SCC sink。
2. 代码额外使用 100 ISK minimum broker fee，但本次检索没有找到足够权威的 CCP 当前页面证明该绝对值；测试中只能证明代码内部一致，不能证明其为当前全场景法定值。标记 UNVERIFIED。
3. Upwell 默认结构费率代码使用 1%，官方说明由结构所有者配置；模型允许 customStructureBrokerFee 覆盖，默认值是假设而非普遍事实。
4. feeModelVersion 未写入凭证，费用模型更新不能被凭证直接检测。
5. 代码使用浮点和 1e-8 分单位检查，当前测试数值无差异，但不是会计级 Decimal。

## 结论

销售税、NPC broker skill/standing 公式和 SCC 分成与官方来源基本一致，SCC 无重复扣费。100 ISK 绝对保底、Upwell 默认费率和 feeModelVersion 绑定仍需补证。费用模型结论为 PARTIAL。
