# EVEAI 第二轮独立审计：投资组合与资金风控模型审查报告

**审计日期**: 2026-11-02  
**审计对象**: `src/trading/portfolio-manager.ts`  
**审计结论**: **【存在缺陷】(Defective)** —— 存在并发草案资金超额占用漏洞、品类风控指标未实施、单品仓位未累计已有持仓、资产估值采用失效 SDE 基准价。

---

## 一、风控约束项审查清单

| 约束项 | 设计指标 | 源码实现位置 | 实际生效情况 | 判定 |
|---|---|---|---|---|
| 安全现金储备 | 保持钱包 20% 现金 | `getCapitalBreakdown` L69 | 仅静态计算可用资金，未扣减在途草案 | **部分验证** |
| 单品持仓上限 | 不得超过投资资金 15% | `validateTradeRisk` L106 | 仅判断单笔新增金额，未累加已有库存与挂单 | **存在缺陷** |
| 品类持仓上限 | 不得超过投资资金 30% | `getCapitalBreakdown` L73 | **完全未在 validateTradeRisk 中校验** | **存在缺陷** |
| 低流动性敞口 | 不得超过投资资金 10% | `DEFAULT_RISK_LIMITS` L14 | **无任何校验逻辑（死代码）** | **存在缺陷** |
| 趋势投机敞口 | 不得超过投资资金 10% | `DEFAULT_RISK_LIMITS` L13 | **无任何校验逻辑（死代码）** | **存在缺陷** |
| 单笔压力损失 | 极限跌幅损失不超过 1.5% | `DEFAULT_RISK_LIMITS` L15 | **无任何校验逻辑（死代码）** | **存在缺陷** |
| T1运输舰防强杀 | 货值上限 50,000,000 ISK | `validateTradeRisk` L93-104 | 生效，但存在重复冗余代码段 | **部分验证** |

---

## 二、关键缺陷深度分析

### 1. 致命并发漏洞：在途审批草案未扣减可用资金
- **现象**:
  当角色拥有 10,000,000 ISK 现金时，`investableCapital` 为 8,000,000 ISK。
  策略引擎扫描出 3 个机会，各需 7,500,000 ISK：
  1. 草案 A 生成并被玩家批准（status = 'approved'），尚未执行。
  2. 随后草案 B 传入 `validateTradeRisk`，由于代码仅查询 `character_wallet.balance`，此时钱包金额仍为 10,000,000 ISK，草案 B 依然判定合法！
  3. 最终玩家执行两笔交易，直接穿透 20% 安全现金红线，甚至发生钱包透支扣费失败。
- **修复逻辑**:
  计算 `investableCapital` 时，必须扣除：
  `SELECT COALESCE(SUM(capital_required), 0) FROM trade_drafts WHERE character_id = ? AND status = 'approved' AND executed_at IS NULL`。

### 2. 品类上限（30%）与单品上限（15%）盲区
- `categoryCapIsk` 在 `getCapitalBreakdown` 中计算后直接闲置，`validateTradeRisk` 根本未接收商品品类或 group_id 参数。
- 单品 15% 检查只检查了单次交易金额 `proposedCost > singleItemCapIsk`。若角色已在吉他仓库持有价值 1,000 万 ISK 的三钛合金，系统再次建议买入 1,000 万 ISK 三钛合金时，风控系统完全失明。

### 3. 库存资产估值算法脱节
- `getCapitalBreakdown` 第 62 行：
  ```typescript
  COALESCE(json_extract(t.data_json, '$.basePrice'), 0) as base_price
  ```
- SDE 的 `basePrice` 是 CCP 预设的静态基准数，例如三钛合金 basePrice 长期为零或几分钱，而市场价为数 ISK；蓝图原本 basePrice 几亿，而蓝图拷贝件市场价仅几十万。以 basePrice 估算总净值（`totalNetWorth`）存在数量级偏差。

---

## 三、代码重复异味（Code Smell）

在 `src/trading/portfolio-manager.ts` 第 93–104 行：
```typescript
    if (strategy === 'regional_hauling' && proposedCost > limits.maxHaulingCargoIsk) {
      return {
        allowed: false,
        reason: `触发高安防自杀强杀风控限制：T1 工业舰单趟货值不得超过 ${Math.round(limits.maxHaulingCargoIsk).toLocaleString()} ISK...`,
      };
    }

    if (strategy === 'regional_hauling' && proposedCost > limits.maxHaulingCargoIsk) {
      return {
        allowed: false,
        reason: `触发高安防自杀强杀风控限制：T1 工业舰单趟货值不得超过 ${Math.round(limits.maxHaulingCargoIsk).toLocaleString()} ISK...`,
      };
    }
```
同一逻辑无意义地连续编写两次，表明此前开发缺乏严格的 Lint 与逻辑复核。
