# EVEAI 第二轮独立审计：费用与税收计算引擎 (src/trading/fee-engine.ts) 审查报告

**审计日期**: 2026-11-02  
**审计对象**: `src/trading/fee-engine.ts`  
**审计结论**: **【存在缺陷】(Defective)** —— 销售税基准税率硬编码错误（8.0% vs CCP 当前标准 7.5%）、缺少 Upwell 建筑 SCC 附加费与 100 ISK 最低费率保护、改单费未在交易结算中启用。

---

## 一、十项审计标准逐项验证结果

| 序号 | 审计项 | 源码现状 | CCP 官方标准 / 真实机制 | 审计判定 |
|---|---|---|---|---|
| 1 | Accounting 技能与销售税公式 | `BASE_SALES_TAX_RATE = 0.08`<br>`8% * (1 - 0.11 * level)` | 当前官方基础税率为 **7.5%**<br>公式为 $7.5\% \times (1 - 11\% \times \text{level})$ | **存在缺陷** |
| 2 | Accounting III 对应税率验证 | 代码计算为 **5.36%** ($8\% \times 0.67$) | 官方实际为 **5.025%** ($7.5\% \times 0.67$) | **存在缺陷** |
| 3 | Broker Relations 与 NPC 站公式 | `3.0% - 0.3%*skill - 0.03%*fac - 0.02%*corp`，下限 1.0% | 与 CCP 2021+ 规范完全一致，下限 1.0% 正确 | **已验证** |
| 4 | NPC 站与 Upwell 建筑区分 | 区分了 `upwell_structure`，自定义费率下限 0.5% | 遗漏了 Upwell 建筑必须上缴给 NPC SCC 的法定附加费 (通常 0.5%~1.0%) | **部分验证** |
| 5 | 即时成交与创建挂单区分 | 吃单方 0 经纪人费；挂单方收取经纪人费；卖方均收销售税 | 机制完全准确，符合 EVE 游戏底层规则 | **已验证** |
| 6 | 买卖两端独立计费 | 区分 `buyerBrokerFee` 与 `sellerBrokerFee` | 结构清晰，费用分立计算无误 | **已验证** |
| 7 | 订单改价额外费用 (Relist Fee) | 函数中计算了 `relistFeeRate`，但在 `calculateTrade` 中完全未使用 | 实际交易评估中将改单成本视为 0，忽略了竞争改价摩擦 | **存在缺陷** |
| 8 | 取消订单沉没成本处理 | 挂单已付经纪人费不退回 | 符合游戏规则，但系统缺乏撤单记录追踪 | **已验证** |
| 9 | 最低经纪人费处理 | 无最低金额限制，小额订单费率可无限趋近于 0 | EVE 游戏底层硬性规定单笔挂单最低经纪人费为 **100.00 ISK** | **存在缺陷** |
| 10 | 技能动态关联与数据来源 | 写死 `ALPHA_DEFAULT_SKILLS` (3/3) | 未从 `character_skills` 表动态加载当前玩家的真实技能 | **存在缺陷** |

---

## 二、关键缺陷详细分析

### 1. 销售税率偏差（8.0% vs 7.5%）
- **代码位置**: `src/trading/fee-engine.ts` 第 3 行与第 37 行：
  ```typescript
  export const BASE_SALES_TAX_RATE = 0.08; // 8.0% baseline
  ```
- **实际规范**: CCP 在 2022 年《Siege Green》及后续版本中，已将全服基础销售税调整为 **7.5%**（旧版曾短期调至 8%）。
- **计算对比 (Alpha 玩家 Accounting III)**:
  - 代码输出: $8.0\% \times (1 - 0.33) = \mathbf{5.360\%}$
  - 真实游戏: $7.5\% \times (1 - 0.33) = \mathbf{5.025\%}$
- **影响**: 代码高估了 0.335% 的销售税。虽然高估费用属于保守估计，但导致系统计算出的保本价 `breakEvenSellPrice` 与真实市场不匹配，且无法通过自动化校验。

### 2. 遗漏 100 ISK 最低经纪人费
- 在游戏内，任何订单的经纪人费如果计算出来低于 100 ISK，一律按 100 ISK 扣除。
- 代码中：
  ```typescript
  const buyerBrokerFee = buyType === 'place_buy_order' ? grossCost * buyRates.brokerFeeRate : 0;
  ```
  如果小额挂单金额为 1,000 ISK，按 2.1% 计算出 21 ISK，代码直接记录 21 ISK，而游戏内实际扣除 100 ISK，在微型套利场景下会产生亏损。

### 3. 玩家真实技能脱节
- `FeeEngine` 声明了 `ALPHA_DEFAULT_SKILLS`（Accounting 3, Broker Relations 3），并将其实例化传递给所有策略。
- 新建立的 Alpha 角色往往 Accounting 为 0 或 1，此时实际税率为 7.5% 或 6.675%，而系统仍按 5.36% 进行测算，将导致新手玩家在不知情的情况下亏损税费。

---

## 三、修复建议代码

在 `src/trading/fee-engine.ts` 中修正如下：
```typescript
// 修正基准销售税
export const BASE_SALES_TAX_RATE = 0.075; // 7.5% CCP Current Baseline
export const MINIMUM_BROKER_FEE_ISK = 100.0; // 100 ISK Floor

// 修正最低经纪人费判断
const buyerBrokerFee = buyType === 'place_buy_order'
  ? Math.max(MINIMUM_BROKER_FEE_ISK, grossCost * buyRates.brokerFeeRate)
  : 0;

const sellerBrokerFee = sellType === 'place_sell_order'
  ? Math.max(MINIMUM_BROKER_FEE_ISK, grossRevenue * sellRates.brokerFeeRate)
  : 0;
```
