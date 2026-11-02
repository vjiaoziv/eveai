# P8.5.6 费用模型官方来源核验

查询日期：2026-11-02。

官方来源：

https://support.eveonline.com/hc/en-us/articles/203218962-Broker-Fee-and-Sales-Tax

官方规则：

- NPC broker fee 基础 3%。
- Broker Relations 每级减少 0.3%。
- NPC 下限 1%。
- Sales tax 基础 7.5%，Accounting 可降低。
- Upwell broker fee 由结构所有者设置，0.5% 为 SCC sink。
- Broker Relations 不适用于 Upwell。

## 最终处理

100 ISK 绝对保底没有找到足够权威的 CCP 当前依据，因此从确定性规则中删除。

src/trading/fee-engine.ts 现在：

- 仅按百分比计算 broker fee。
- 金额四舍五入到 2 位小数。
- FEE_MODEL_VERSION = eveai-fee-2026-11-v1。
- 凭证绑定 feeModelVersion。

测试：

- tests/unit/trading-fee-simulator.test.ts
- tests/unit/p8-5-5-a01-a24.test.ts A21

结论：R06 通过“移除无依据绝对保底”清零。
