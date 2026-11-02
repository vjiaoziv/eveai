# EVEAI P8：订单簿穿透仿真器验证报告 (P8_ORDERBOOK_SIMULATION.md)

**完成日期**: 2026-11-02  
**关联代码**: `src/trading/orderbook-simulator.ts`, `src/trading/trading-pipeline.ts`

---

## 一、订单簿模拟器核心算法

`OrderBookSimulator` 实现了严格的离散订单簿多档位遍历（Walk-the-book）算法：

### 1. 采购端模拟 (`simulateBuy`)
- 对卖单按价格**升序 (ASC)** 排序。
- 逐档消耗 `volumeRemain`，直至满足 `targetQuantity` 或深度耗尽。
- 输出实际加权买价：
  $$\bar{P}_{\text{buy}} = \frac{\sum_{i=1}^{k} P_i \times Q_i}{\sum_{i=1}^{k} Q_i}$$
- 精确计算采购滑点：$\text{Slippage \%} = \frac{\bar{P}_{\text{buy}} - P_{\text{top}}}{P_{\text{top}}} \times 100\%$。

### 2. 销售端模拟 (`simulateSell`)
- 对买单按价格**降序 (DESC)** 排序。
- 逐档吃入 `volumeRemain`，输出加权卖价与价格降阶滑点：
  $$\bar{P}_{\text{sell}} = \frac{\sum_{i=1}^{m} P_i \times Q_i}{\sum_{i=1}^{m} Q_i}$$

---

## 二、首笔草案情景下的仿真对比测试

针对激光炮 Type 6675 提议采购 29 件的极端场景：

```typescript
// 采购端吉他真实卖盘: 2@274.9k, 1@275k, 5@290k, 53@369.8k
const buySim = OrderBookSimulator.simulateBuy(jitaSells, 29);
// 结果:
// buySim.weightedAvgPrice = 346,227.59 ISK (+25.95% 滑点)
// buySim.totalGrossIsk = 10,040,600.00 ISK
// levelsConsumed = 4

// 销售端杜迪克西真实买盘: 2@700k, 12@4601, 2@4600, 7@4201, 126@4200
const sellSim = OrderBookSimulator.simulateSell(dodixieBuys, 29);
// 结果:
// sellSim.weightedAvgPrice = 52,379.97 ISK (-92.52% 价格断崖)
// sellSim.totalGrossIsk = 1,519,019.00 ISK
// levelsConsumed = 5
```

**仿真器证明**:
当系统接入真实的 `OrderBookSimulator` 后，该笔交易的预期毛亏损立即暴露出 $-8,521,581\text{ ISK}$，管线在第 4 阶段即可精准识别并直接予以风险阻断。
