# EVEAI 第二轮独立审计：市场数据中心与订单簿仿真器审查报告

**审计日期**: 2026-11-02  
**审计对象**: `src/trading/data-center.ts`, `src/trading/orderbook-simulator.ts`  
**审计结论**: **【存在缺陷】(Defective)** —— 订单簿仿真器被核心策略旁路、多星域快照时间戳严重漂移、缺少数据熔断与异常价格检测机制。

---

## 一、订单簿与数据中心审计矩阵

| 审计项目 | 源码设计 | 运行实际表现 | 审计结论 |
|---|---|---|---|
| 深度逐档计算 | `OrderBookSimulator` 支持累加与滑点计算 | 核心策略（如 `regional-hauling.ts`）完全未调用该类，直接按单价计算 | **存在缺陷** |
| 跨星域时间同步 | `DataCenter.getOrderBook` 接收 regionId | 比较两地价格时，未校验两地订单采集时间差（曾出现 13.5 小时时间差） | **存在缺陷** |
| 缓存与过期处理 | ESI 请求单次返回 | 数据库内无订单失效清理逻辑，已过期的历史订单仍混在表中参与聚合 | **存在缺陷** |
| 部分成交支持 | 仿真器返回 `isComplete`, `filledQty` | 策略层直接假定 100% 全部成交 | **存在缺陷** |
| 异常挂单检测 | 无异常值过滤模块 | 杜迪克西 700k 的诱多买单（正常价 4.6k）被直接采纳为基准价格 | **存在缺陷** |
| 数据故障降级 | `data_source_status` 记录错误 | 记录状态后，交易扫描依然盲目运行，没有断路器（Circuit Breaker）停止推荐 | **存在缺陷** |

---

## 二、架构层核心缺陷深度分析

### 1. 策略层与仿真器的严重脱节
`OrderBookSimulator` 的单元测试全部通过，但它是一个**孤岛模块**。
在 `RegionalHaulingStrategy.scan` 与 `StationArbitrageStrategy.scan` 中：
- 策略直接使用 SQL 聚合函数 `min(price)` 和 `max(price)` 获取所谓的“最优买卖价”；
- 交易量直接取全站订单剩余量的总和 `sum(volume_remain)`；
- 导致把 1,006 ISK 的万件买单深度，套用到 700,000 ISK 的顶格价格上。

### 2. 跨星系时间戳漂移（Timestamp Skew）
EVE 的市场数据更新机制是按星域（Region）分批拉取的：
- 吉他（The Forge）数据可能在上午 09:00 更新；
- 杜迪克西（Sinq Laison）数据可能在深夜 23:00 才拉取；
- 两者相差十几个小时。在这期间，高利润差价商品很可能早在上午就被其他玩家搬运抹平。系统缺乏时间窗口约束（如强制两地快照时间差必须 $\le 15$ 分钟）。

---

## 三、修复建议方案

1. **废除策略内部的粗暴 SQL 聚合**：
   策略扫描第一阶段仅用于筛选候选池，在第二阶段生成草案前，**强制调用** `OrderBookSimulator.simulateBuy` 和 `OrderBookSimulator.simulateSell`。
2. **增加时间戳一致性前置检查**:
   ```typescript
   const timeDiffMinutes = Math.abs(new Date(buyOrder.issued).getTime() - new Date(sellOrder.issued).getTime()) / 60000;
   if (timeDiffMinutes > 30) {
     // 时间差超过 30 分钟，强制放弃或标记为高风险过期数据
   }
   ```
3. **增加统计学价格异常过滤器**:
   比较目标买单单价与该星区 30 日历史均价，若偏离度超过 $+50\%$ 且剩余数量 $< 5$，强制触发人工核查标记，禁止自动纳入高置信度套利推荐。
