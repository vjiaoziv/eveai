# EVEAI P8：投资组合与资金风控验证报告 (P8_PORTFOLIO_RISK_VALIDATION.md)

**完成日期**: 2026-11-02  
**关联代码**: `src/trading/portfolio-manager.ts`

---

## 一、风控模型修复重点

### 1. 资金池状态机与在途草案扣减
P8 彻底修复了草案并发导致的超额投资漏洞。
可用投资资金计算公式升级为：
$$\text{Investable Capital} = \max(0, \text{Wallet} - \text{CashReserve}_{20\%} - \text{InFlightDrafts}_{\text{approved}})$$
- 任何处于 `approved` 且尚未在游戏内完成（`executed_at IS NULL`）的草案，其所需资金将**被硬性锁定**。
- 并发生成或审批第二笔草案时，只能在扣除锁定金额后的净剩余资金池中审批，彻底杜绝穿透 20% 安全储备的风险。

### 2. 全局累计持仓风控
- **单品 15% 上限**:
  $$\text{Total Item Exposure} = \text{Existing Inventory Value} + \text{InFlight Draft Value} + \text{Proposed Cost} \le \text{SingleItemCap}_{15\%}$$
- **品类 30% 上限**:
  通过 SDE `sde_groups` 关联商品的 `category_id`，累计当前工业大类（如舰船、装备、矿物、行星产物）已有持仓与提议投入，不得超过投资总额的 30%。
- **高安防强杀货值门禁**:
  对 `regional_hauling` 策略严格执行单趟工业舰 **50,000,000 ISK** 货值上限，消除了旧版代码中的重复段落。

---

## 二、测试验证

在 `tests/unit/trading-system-full.test.ts` 中执行以下极端用例：
1. **现金 100M，安全储备 20M，可用 80M**：
   - 批准 50M 的首笔草案，可用资金精准下落至 30M。
   - 尝试发起 40M 的第二笔草案，风控系统成功拦截并明确提示：
     `"超出可用投资资金上限：所需资金 40,000,000 ISK，当前最大可投资金额 30,000,000 ISK（已扣除 20% 安全现金储备 20,000,000 ISK 及在途审批资金 50,000,000 ISK）"`。
2. **防强杀货值拦截**：
   - 提议 60M 跨星系运输，系统精准阻断：`"触发高安防自杀强杀风控限制：T1 工业舰单趟货值不得超过 50,000,000 ISK..."`。
