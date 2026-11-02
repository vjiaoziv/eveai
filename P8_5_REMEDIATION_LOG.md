# EVEAI P8.5：代码级修改日志与纠偏明细 (P8_5_REMEDIATION_LOG.md)

**完成日期**: 2026-11-02  
**执行分支**: `deploy/eve-ai-agent`

---

## 修改文件与函数明细

### 1. `src/trading/data-center.ts`
- **修改函数**: `validateTemporalConsistency`
- **原问题**: 读取 `order.issued`（玩家发布订单时间），将挂了几个月的有效订单误当作数据采集时间。
- **现逻辑**: 读取 `market_snapshot_regions` 表中真实的 `fetched_at` 和 `expires_at`，严格基于采集批次核算两地时差。

### 2. `src/trading/orderbook-simulator.ts`
- **修改函数**: 新增 `findOptimalProfitableQuantity`
- **原问题**: 上层策略为了防范风险粗暴截断为第一档 `topBuy.volumeRemain`，放弃了多档深度。
- **现逻辑**: 实现边际收益贪心搜索，遍历买卖订单簿关键档位，在边际收入低于边际成本前自动截断，动态找到最大经济可交易量 $Q^*$。

### 3. `src/trading/trading-pipeline.ts`
- **修改函数**: `evaluateCandidate`
- **原问题**: 简单取第一档数量，导致多档订单簿模拟能力失效；数据时差核验使用错误的 `issued`。
- **现逻辑**: 整合 `DataCenter.validateTemporalConsistency` 与 `OrderBookSimulator.findOptimalProfitableQuantity`，完成 10 阶段闭环。

### 4. `src/trading/backtesting/engine.ts`
- **修改函数**: `runHistoricalBacktest`
- **原问题**: T 日产生信号并在 T 日以全天均价买入，构成了日线级别的未来数据泄漏。
- **现逻辑**: 严格实施时序分立：Day T 收盘生成信号 $\to$ Day T+1 挂单买入 $\to$ Day T+2 出场平仓。

### 5. `src/trading/portfolio-manager.ts`
- **修改函数**: `getCapitalBreakdown`
- **原问题**: 仅取单一最高买单单价乘以全部库存，虚增未变现资产总值；未隔离蓝图拷贝件 (BPC)。
- **现逻辑**: 针对吉他 4-4 订单簿逐档模拟出售，区分 `liquidInventoryValue`、`illiquidInventoryValue`，并将 BPC 归入 `specialAssetsCount`。

### 6. `src/trading/draft-system.ts`, `src/web/trading-routes.ts`, `scripts/eve-cli.ts`
- **修改函数**: `updateStatus`, `recordManualExecution`
- **原问题**: 缺少对 `audit_revoked` 草案在 API 与 CLI 层的统一异常捕获与阻断。
- **现逻辑**: 状态机增加强阻断校验，Web 路由返回 HTTP 403，CLI 打印清晰安全拦截日志。

### 7. 数据库表 `trade_drafts`
- **更新字段**: 更新 `TR-2026-000001` 的 `revoked_reason` 为符合事实的“模拟成交测算重大风险”标准描述。
