# EVEAI P8.5：仓库库存估值深度与特殊资产审计 (P8_5_INVENTORY_VALUATION_AUDIT.md)

**完成日期**: 2026-11-02  
**关联代码**: `src/trading/portfolio-manager.ts`

---

## 一、库存估值的两大核心缺陷与纠偏

### 1. 缺陷一：最高买单单价乘以全部库存
- **错误逻辑**: 假定仓库有 100 件某装备，吉他最高买单为 100 万 ISK，系统直接判定该库存价值 1 亿 ISK。
- **现实陷阱**: 100 万的买单可能只有 1 件，后续买盘断崖至 5 万 ISK。盲目乘法导致账面总净值严重虚高数十倍。
- **P8.5 纠偏实现**:
  对每种库存货物，调用 `OrderBookSimulator.simulateSell(jitaBuys, item.quantity)`：
  逐档模拟其在吉他 4-4 现货买单中的承接能力。只有订单簿实际能承接的部分按加权净额计入高流动性资产，未被覆盖的尾部一律归入低流动性甚至零估值。

### 2. 缺陷二：将特殊资产误判为市场现货
- **典型案例**: 玩家吉他仓库中的 `移动相位锚标蓝图`（Type ID 90039）。
  市场买单高达 6,000 万 ISK，但该买单仅接受**蓝图原本 (BPO)**！
  玩家持有的实际上是**蓝图复制件 (BPC)**（`is_blueprint_copy === 1`）。在 EVE 机制中，BPC 无法通过常规区域市场订单出售，只能走合同区。
- **P8.5 纠偏实现**:
  建立特殊资产隔离池：
  ```typescript
  if (item.is_blueprint_copy === 1) {
    specialAssetsCount += 1;
    // BPC 蓝图拷贝件严禁计入市场即时变现资产
    continue;
  }
  ```

---

## 二、资产结构清晰分层输出

P8.5 重构后的 `CapitalBreakdown` 结构：
1. **现金资产 (`walletBalance`)**: 钱包实际流动现金。
2. **冻结资金 (`escrowLocked`)**: 挂在市场买单中的担保金。
3. **在途审批资金 (`inFlightCommittedIsk`)**: 已审批草案锁定的专款。
4. **高流动性现货估值 (`liquidInventoryValue`)**: 经吉他订单簿逐档真实撮合测算的税后可回收现金。
5. **低流动性/死库存估值 (`illiquidInventoryValue`)**: 当前订单簿无买单承接的滞销品。
6. **特殊非标资产数量 (`specialAssetsCount`)**: BPC 拷贝件、非公开合同物品等。

---

## 三、测试用例验证 (Case E)

在 `tests/unit/p8-5-integration.test.ts` 中构建测试：
- 仓库持有 100 件三钛合金及 1 件 BPC。
- 吉他买单仅有 10 件 @ 5.0 ISK，其余 90 件无买盘。
- **测试输出 (PASS)**:
  - `specialAssetsCount === 1`（BPC 被精准识别隔离，0 变现计入）。
  - `liquidInventoryValue === 47.49 ISK`（精准撮合 10 件，扣除 5.025% 销售税）。
  - `illiquidInventoryValue === 180 ISK`（剩余 90 件按 2 ISK 保底基准价归入低流动性资产）。
