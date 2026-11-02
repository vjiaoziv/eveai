# P8.7 基线与现有能力

日期：2026-11-02（Asia/Shanghai）

## 基线检查

执行命令：

~~~text
git status --short
git branch --show-current
git rev-parse HEAD
git log -8 --oneline
~~~

结果：

- 项目：/home/ubuntu/projects/eveai
- 分支：deploy/eve-ai-agent
- HEAD：23f32fb8cc5e693f19d46a03e5ad86d44383aecf
- 工作区：干净
- Paper Trading 数据库：data/eve-agent.db，约 1.1 GB

数据库当前样本：

| 表 | 数量 |
|---|---:|
| paper_trading_accounts | 0 |
| paper_trading_orders | 0 |
| paper_trading_positions | 0 |
| paper_trading_journal | 0 |
| trade_opportunities_log | 0 |
| trade_drafts | 1（audit_revoked） |
| market_snapshot_regions | 68 |
| market_price_history | 32,214 |
| backtest_runs | 0 |

结论：当前没有足够的真实 Paper Trading 运行样本。P8.7 不得虚构成交率、净收益或策略排名。

## 已实现能力

| 能力 | 位置 | 状态 |
|---|---|---|
| 站内套利扫描 | src/trading/strategies/station-arbitrage.ts:16 | 已实现 scan |
| 跨贸易中心套利 | src/trading/strategies/regional-hauling.ts:58 | 已实现 scan |
| 再处理分析 | src/trading/strategies/manufacturing-arbitrage.ts:29 | 已实现 analyzeReprocessing |
| 趋势分析 | src/trading/strategies/trend-following.ts:25 | 已实现 analyzeTrend |
| 事件驱动 | src/trading/strategies/event-driven.ts:22 | 仅有数据类型/评分辅助，无完整扫描或成交链路 |
| 市场做市 | StrategyType 已定义 | 未找到专用实现 |
| 交易管线 | src/trading/trading-pipeline.ts | 已实现，含凭证、风控、深度和快照绑定 |
| 订单簿模拟 | src/trading/orderbook-simulator.ts:9,69,133,234 | 保守吃单、最优数量、压力测试已实现 |
| Paper Trading | src/trading/paper-trading.ts | 账户、订单、持仓、journal、组合查询已实现 |
| 回测 | src/trading/backtesting/engine.ts:56 | 历史回测、回撤、胜率、Sharpe 已实现 |
| 交易 API | src/web/trading-routes.ts | 扫描、草案、Paper portfolio API 已实现 |
| 前端交易仪表盘 | web/src | 未发现专用交易/绩效组件 |

## 数据表结构

- src/db/migrations.ts:787 paper_trading_accounts
- src/db/migrations.ts:800 trade_opportunities_log
- src/db/migrations.ts:820 paper_trading_orders
- src/db/migrations.ts:840 paper_trading_journal
- src/db/migrations.ts:772 paper_trading_positions

## 初步判断

1. 机会发现链路存在，但当前生产数据库没有机会日志样本。
2. 模拟吃单有订单簿深度，但缺少逐笔 fill 记录、限价排队证据和分级成交模型。
3. Paper Trading 有账户和账本，但当前没有真实运行样本。
4. 回测指标存在，但没有独立绩效归因和样本充足性门禁。
5. 前端交易仪表盘尚未实现。
6. 六类策略中仅站内套利、跨区套利有完整扫描；再处理和趋势是分析能力；做市与事件驱动不完整。

## P8.7 实现增量

- 统一机会记录与四层利润字段：`src/db/migrations.ts:128`、`src/trading/paper-trading.ts:285`
- Mode A/B/C 分级成交：`src/trading/orderbook-simulator.ts:142,211`、`src/trading/paper-trading.ts:606`
- FIFO 退出与逐批毛利：`src/db/migrations.ts:165`、`src/trading/paper-trading.ts:849`
- 独立绩效与时间泄漏审计：`src/trading/performance-analytics.ts:254,480`
- 运行验证门禁：`src/trading/runtime-validation.ts:45`
- 运行 API：`src/web/trading-routes.ts:178-269`
- 前端 Paper Trading 页面：`web/src/components/TradingScreen.tsx:87`

基线生产数据库样本数量仍为 0，因此最终策略状态必须保持 `INSUFFICIENT_SAMPLE`。