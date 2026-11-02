# EVEAI 交易税费精确计算模型与规则手册
**文档编号**：`FEE_CALCULATION.md`  
**基准版本**：CCP 官方 2026 年最新市场税制  
**代码对应**：`src/trading/fee-engine.ts`

---

## 一、官方税制构成要素

在 EVE Online 市场交易中，产生交易成本的四个核心环节如下：

```
[ 交易全流程税费图谱 ]
       │
       ├─ 买入端 ─── 挂买单 (Place Buy) ────► 扣除：买入经纪人费用 (Buyer Broker Fee)
       │         └── 吃卖单 (Eat Sell)  ────► 零费用 (免税、免经纪人费)
       │
       ├─ 挂单中 ─── 修改订单 (Relist)   ────► 扣除：改单手续费 (Relist / PDS Fee)
       │
       └─ 卖出端 ─── 挂卖单 (Place Sell) ───► 扣除：卖出经纪人费 + 成交时扣除销售税 (Sales Tax)
                 └── 吃买单 (Eat Buy)   ────► 扣除：销售税 (免经纪人费)
```

---

## 二、确定性计算公式

### 1. 销售税 (Sales Tax)
销售税在物品成功卖出并结算变现的瞬间由系统直接从成交总额中扣除：
$$\text{SalesTaxRate} = 8.0\% \times \left(1 - 0.11 \times \text{AccountingLevel}\right)$$

| 技能等级 | 对应克隆资质 | 实际销售税率 | 变现 10,000,000 ISK 扣税 |
| :---: | :---: | :---: | :---: |
| **0 级** | 基础无技能 | **8.00%** | 800,000 ISK |
| **1 级** | Alpha / Omega | **7.12%** | 712,000 ISK |
| **2 级** | Alpha / Omega | **6.24%** | 624,000 ISK |
| **3 级** | **Alpha 技能上限** | **5.36%** | **536,000 ISK** |
| **4 级** | 仅限 Omega | **4.48%** | 448,000 ISK |
| **5 级** | 仅限 Omega (满级) | **3.60%** | 360,000 ISK |

### 2. 经纪人费用 (Broker Fee)
经纪人费用在玩家设立挂单（主动委托订单）的瞬间预先扣除，即使后续撤单亦不退还：
- **在 NPC 空间站 (如 Jita 4-4, Dodixie IX-20)**：
  $$\text{BrokerFeeRate} = 3.0\% - 0.3\% \times \text{BrokerRelations} - 0.03\% \times \text{FactionStanding} - 0.02\% \times \text{CorpStanding}$$
  - NPC 空间站法定保底费率下限为 **1.00%**；
  - 针对典型的 Alpha 玩家（Broker Relations 3级，无声望）：
    $$\text{BrokerFeeRate} = 3.0\% - 0.3\% \times 3 = \mathbf{2.10\%}$$
- **在玩家上层建筑 (Upwell Citadels / Engineering Complexes)**：
  - 费率由建筑所有者自定义设定（通常公用商业堡垒设定在 0.5% ~ 1.5% 之间）；
  - 建筑最低保底法定底线为 **0.50%**。

### 3. 改单附加费 (Relist Fee)
当修改已有订单的价格时，系统征收改单费：
- Alpha 克隆无法学习高级经纪人关系学（Advanced Broker Relations），故每次修改价格均按当前经纪人费率承担全额改单损耗；
- 因此系统算法规定：**Alpha 飞行员在低毛利品类中严禁频繁改单**。

---

## 三、四大核心交易模式费用核算矩阵

针对采购单价 $P_{buy}$、销售单价 $P_{sell}$、交易数量 $Q$：

| 模式 | 买入方式 | 卖出方式 | 买入总支出 | 卖出总净回笼 | 综合税费磨损 (Alpha 3级) |
| :--- | :--- | :--- | :--- | :--- | :---: |
| **A. 纯即时倒卖** | 吃吉他卖单 | 吃目标站买单 | $P_{buy} \times Q$ | $P_{sell} \times Q \times (1 - 5.36\%)$ | **5.36%** (仅一次销售税) |
| **B. 进货挂单出** | 吃吉他卖单 | 目标站挂卖单 | $P_{buy} \times Q$ | $P_{sell} \times Q \times (1 - 2.10\% - 5.36\%)$ | **7.46%** (卖端经纪人+销售税) |
| **C. 站内双挂单** | 吉他挂买单 | 吉他挂卖单 | $P_{buy} \times Q \times (1 + 2.10\%)$ | $P_{sell} \times Q \times (1 - 2.10\% - 5.36\%)$ | **9.56%** (双边经纪人+销售税) |
| **D. 挂买即时吃** | 目标站挂买单 | 本地即时出 | $P_{buy} \times Q \times (1 + 2.10\%)$ | $P_{sell} \times Q \times (1 - 5.36\%)$ | **7.46%** (买端经纪人+销售税) |

### 4. 精确保本卖出价公式
在模式 B（吃货后运去挂卖单）下，确保利润不亏损的理论最低卖价：
$$\text{BreakEvenSellPrice} = \frac{P_{buy} \times Q + \text{HaulingCost}}{Q \times \left(1 - \text{BrokerFeeRate} - \text{SalesTaxRate}\right)}$$
以 Alpha 3 级技能、吉他进价 100,000 ISK 为例：
$$\text{BreakEvenSellPrice} = \frac{100,000}{1 - 0.021 - 0.0536} = \frac{100,000}{0.9254} \approx \mathbf{108,061.38\text{ ISK}}$$
即标的物品必须在目的地卖出高于 **108,062 ISK** 才能真正盈利，否则一切价差皆为税收亏损。
