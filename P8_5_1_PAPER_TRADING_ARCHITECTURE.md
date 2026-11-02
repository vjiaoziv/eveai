# EVEAI P8.5.1：Paper Trading 模拟盘系统架构说明书 (P8_5_1_PAPER_TRADING_ARCHITECTURE.md)

**完成日期**: 2026-11-02  
**关联代码**: `src/trading/paper-trading.ts`, `src/db/migrations.ts`

---

## 一、系统架构与数据模型

Paper Trading 是一套完全隔离于真实 EVE 资产的沙盒模拟交易引擎，其数据库架构由四张核心表驱动：

```text
┌─────────────────────────┐         ┌─────────────────────────┐
│ trade_opportunities_log │ ──────> │   paper_trading_orders  │
│ (前置记录所有机会与否决)  │         │ (虚拟订单:挂单/吃单/撤单) │
└─────────────────────────┘         └─────────────────────────┘
                                                 │
                                                 ▼
┌─────────────────────────┐         ┌─────────────────────────┐
│ paper_trading_accounts  │ <────── │ paper_trading_positions │
│ (虚拟独立资金池:现金/担保)│         │ (模拟持仓多档市值跟踪)   │
└─────────────────────────┘         └─────────────────────────┘
```

### 1. 核心表结构规范
- **`paper_trading_accounts`**:
  - `account_id` (如 `PT-ACC-2124784765`)
  - `initial_cash` (初始虚拟本金，默认 10,000,000 ISK，不读取角色真实钱包)
  - `available_cash` (可用资金)
  - `escrow_locked` (买单冻结资金)
  - `total_realized_pnl` (已实现模拟盈亏)
  - `total_fees_paid` (累计模拟税费)
- **`trade_opportunities_log`**:
  - 机会先于结果记录（Pre-trade logging）：无论机会最终是否成交，甚至被风控否决（`vetoed`），都必须完整记录。
  - 跟踪预测偏差：
    $$\text{Prediction Variance} = \text{Actual Simulated Net Profit} - \text{Expected Net Profit}$$
- **`paper_trading_orders`**:
  - 支持 `open`、`partially_filled`、`filled`、`cancelled`、`expired` 全状态流转。
  - 订单创建时，由 SQLite 事务同步锁定对应金额的 Escrow，严禁超额认购。

---

## 二、六大策略隔离独立统计

系统支持对以下 6 类策略独立建账统计：
1. `regional_hauling` (跨星系运输套利)
2. `station_arbitrage` (空间站差价套利)
3. `manufacturing_arbitrage` (解体再处理套利)
4. `trend_following` (趋势跟踪策略)
5. `event_driven` (事件驱动策略)
6. `market_making` (做市策略)

每个策略分别统计其机会总数、否决率、真实成交率、已实现盈亏与平均预测偏差，严禁将不同策略混为一谈。
