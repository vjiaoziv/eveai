# EVEAI P8.5.2：订单簿模拟器鲁棒性与边界审计报告 (P8_5_2_ORDERBOOK_AUDIT.md)

**完成日期**: 2026-11-02  
**关联代码**: `src/trading/orderbook-simulator.ts`

---

## 一、模拟器算法完整性核查

### 1. 价格优先原则 (Price Priority)
- 买入模拟 (`simulateBuy`): 卖盘首先按价格升序排序 (`a.price - b.price`)，优先吃最低价卖单。
- 卖出模拟 (`simulateSell`): 买盘首先按价格降序排序 (`b.price - a.price`)，优先吃最高价买单。
- 撮合逻辑严格逐档消耗 `volumeRemain`，已消耗数量即时扣除，同一订单绝不重复计算。

### 2. 边际收益动态截断 (`findOptimalProfitableQuantity`)
- 算法遍历订单簿档位边界，计算每新增 1 件商品的边际税后变现额 $P_{\text{sell}} \times (1 - \text{Tax})$ 与采购成本 $P_{\text{buy}}$。
- 若边际收益出现负数（如深度断崖），立即终止扩展，杜绝将深档垃圾订单作为有效深度。

---

## 二、边界值、异常输入与鲁棒性测试

在 `tests/unit/p8-5-2-stress.test.ts` (Scenario K & N) 中输入各类恶意/极端数据：
1. **负数与零测试**:
   - `quantity = -50` 或 `price = 0` $\to$ 系统直接校验拦截，返回合法性错误。
2. **NaN / 非有限数值测试**:
   - `price = NaN` 或 `quantity = Infinity` $\to$ `Number.isFinite` 检查拦截。
3. **空订单簿测试**:
   - 订单簿为 `[]` $\to$ 模拟器安全返回 `filledQty: 0`, `isComplete: false`，无未捕获异常。
4. **超大规模深度测试**:
   - 面对 100,000 件分部于 20 个档位的订单簿，多档遍历在 1ms 内完成，无死循环或内存暴涨风险。
