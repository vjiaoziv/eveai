# EVEAI P8.5.1：多层资产估值与 BPC 处置报告 (P8_5_1_ASSET_VALUATION_AUDIT.md)

**完成日期**: 2026-11-02  
**关联代码**: `src/trading/portfolio-manager.ts`

---

## 一、蓝图拷贝件 (BPC) 经济价值定位

在 EVE Online 经济学中：
1. **普通区域市场 (Regional Market)**:
   - 规则：仅支持**蓝图原本 (BPO)** 挂单买卖。
   - BPC 试图挂单或卖给买单时，客户端直接拒绝。
   - **因此：BPC 在普通市场的即时可变现价值硬性定义为 0.00 ISK**。
2. **合同市场 (Contract Market)**:
   - 规则：通过物品交换合同（Item Exchange Contract）出售。
   - 潜在价值：取决于拷贝流程数（Runs）、材料减免等级（ME）与时间减免等级（TE）。
   - **处置**: 系统不在普通钱包可用资金中计入 BPC，而是将其作为非标特殊资产单独统计 (`specialAssetsCount`)，并标注合同市场参考估值为 `UNKNOWN`，待合同估值模块开发后再行引入。

---

## 二、仓库库存多层次分级估值表

在 `PortfolioManager.getCapitalBreakdown` 中分层输出：

| 资产层级 | 定义口径 | 估值依据 | 计入投资总净值 |
|---|---|---|---|
| **现金资产 (`walletBalance`)** | 钱包当前可用 ISK | 官方 ESI 实时同步 | 是 (流动性最高) |
| **担保金 (`escrowLocked`)** | 买单已冻结资金 | 官方订单表汇总 | 是 |
| **高流动性库存 (`liquidInventoryValue`)** | 仓库中能够在吉他 4-4 买盘中被即时吸收的货物 | 调用 `OrderBookSimulator.simulateSell` 逐档撮合后的税后净额 | 是 |
| **低流动性库存 (`illiquidInventoryValue`)** | 订单簿深度耗尽后的剩余库存，或无买单货物 | 按 SDE 基础价格折价 50% 保底计量，标注为滞销资产 | 谨慎计入 |
| **非标特殊资产 (`specialAssetsCount`)** | BPC 拷贝件、非公开合同物品、未打包舰船 | 无法通过常规市场变现，仅展示持有件数，变现值计 0 | **否 (严禁计入投资池)** |
