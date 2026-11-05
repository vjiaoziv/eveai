# EVEAI 市场投资多数据源接入与合规性审计报告
**文件编号**：`DATA_SOURCE_AUDIT.md`  
**基准日期**：2026-11-02  
**审计目标**：评估 CCP 官方 ESI 接口、本地静态 SDE 及第三方开源市场数据源的可用性、协议规范、调用限制与数据治理方案。

---

## 一、主备数据源矩阵与连通性实测

| 数据源 | 核心用途与端点 | 连通性与实测结果 | 更新频率与缓存期 | 许可与调用约束 |
| :--- | :--- | :---: | :--- | :--- |
| **CCP 官方 ESI**<br>`https://esi.evetech.net/` | 1. 区域挂单：`/markets/{region_id}/orders/`<br>2. 历史日线：`/markets/{region_id}/history/`<br>3. 角色钱包、资产与订单：`/characters/{id}/*` | **【主数据源】**<br>HTTP 200 (通过本地代理)<br>实测延迟约 1.2s | • 订单簿：5 分钟（强缓存）<br>• 历史成交：每日 11:00 UTC<br>• 个人资产：60 分钟<br>• 钱包余额：2 分钟 | • 严格遵守 100 错误计数/分钟熔断机制；<br>• 必须携带合规的 `User-Agent` 与联系人；<br>• 支持 ETag / 304 增量更新。 |
| **EVE SDE (本地静态库)**<br>`./data/sde/` | 1. 物品定义：`sde_types`<br>2. 星系拓扑：`sde_systems`, `sde_stargates`<br>3. 制造拆解：`sde_type_materials` | **【离线基础源】**<br>本地 SQLite 直接查询<br>0 毫秒极速响应 | 静态数据，随 CCP 游戏版本更新（当前为 2026-10 最新版本） | • 纯离线无外部网络风险；<br>• 需维护 `sde_meta` 记录构建编号。 |
| **Fuzzwork Market API**<br>`https://market.fuzzwork.co.uk/` | 1. 聚合统计行情：`/aggregates/`<br>2. 跨区域价格快速交叉校验 | **【第一备份源】**<br>实测 HTTP 200 OK<br>响应体约 416 字节 | 约 5~15 分钟聚合一次 | • 免费公开服务，应限制并发（建议 2~5 并发）；<br>• 严禁用作高频无休止轮询。 |
| **EVE Ref**<br>`https://data.everef.net/` | 1. 全宇宙历史日度全量 CSV/JSONL 数据包<br>2. 历史回测基准行情导出 | **【回测离线源】**<br>支持分日批量下载历史数据集 | 每日归档一次 | • 适合作为 P6 历史回测系统的离线行情冷启动载体。 |
| **Adam4EVE**<br>`https://www.adam4eve.eu/` | 1. 宏观工业材料价格指数<br>2. 长期价格分位数与趋势研究 | **【宏观参考源】**<br>网络已连通 | 日度/周度汇总 | • 适合作为宏观投资分析模块的参考基准。 |
| **zKillboard / EVE-KILL**<br>`src/eve-kill/` | 1. 重点高安咽喉星系战损监测<br>2. 高危军团与自杀强杀活跃度指标 | **【风控安全源】**<br>项目内置 REST 客户端与轮询器 | 实时 / 1 分钟长轮询 | • 用于动态修正跨区域高安航线的安全溢价与强杀风险。 |

---

## 二、数据采集、清洗与合规治理准则

1. **缓存一致性与零冗余原则**：
   - 严格遵循 CCP ESI 的 `Expires` 与 `ETag` 标头。未到过期时间的资源，系统本地缓存直接返回，绝不发起高频无意义的重复网络探测。
   - 遇到 HTTP 429 或 5xx 故障时，必须执行指数退避（Exponential Backoff with Jitter），上限不超过 30 秒。
2. **严禁“点价格”替代“全量撮合”**：
   - 在计算采购成本时，绝对禁止以当前盘口最低卖价（Lowest Sell）直接乘以总数量；必须按照目标采购量 $Q$ 逐档遍历订单簿，计算加权采购成本。
   - 在计算变现收入时，绝对禁止以最高买单价（Highest Buy）直接充当全额变现收益；买单深度不足时，未消化部分必须做截断并明确风险提示。
3. **数据可追溯与时效性标记**：
   - 数据库中落盘的每一条市场记录均强制携带四个元数据维度：
     `source`（来源）、`collected_at`（本地采集时间戳）、`server_time`（游戏服务器生成时间）、`data_status`（valid / stale / partial）。
   - 严禁大模型自行编造、插值或推断缺失的市场报价。

---

## 三、投资系统数据库扩展规划 (Schema Extensions)

为支撑 P1~P7 阶段的指标计算、投资组合与回测需求，计划在现有 `./data/eve-agent.db` 基础上采用增量迁移（无损扩展），新增如下数据表：

```sql
-- 1. 数据源状态与健康度追踪表
CREATE TABLE IF NOT EXISTS data_source_status (
  source_id       TEXT PRIMARY KEY,
  status          TEXT NOT NULL CHECK (status IN ('ok', 'degraded', 'offline')),
  last_success_at TEXT,
  last_error      TEXT,
  error_count_1h  INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 2. 投资组合持仓与头寸表
CREATE TABLE IF NOT EXISTS portfolio_positions (
  position_id     TEXT PRIMARY KEY,
  character_id    INTEGER NOT NULL,
  type_id         INTEGER NOT NULL,
  location_id     INTEGER NOT NULL,
  quantity        INTEGER NOT NULL,
  cost_basis      REAL NOT NULL, -- 采购均价成本
  current_price   REAL,          -- 当前公允估值
  unrealized_pnl  REAL,          -- 浮动盈亏
  strategy_type   TEXT NOT NULL, -- 'station_arbitrage' | 'regional_hauling' | 'trend'
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'partial', 'closed')),
  opened_at       TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at       TEXT
);

-- 3. 交易草案与决策指令表 (Draft Orders)
CREATE TABLE IF NOT EXISTS trade_drafts (
  draft_id        TEXT PRIMARY KEY, -- e.g. 'TR-2026-000001'
  character_id    INTEGER NOT NULL,
  type_id         INTEGER NOT NULL,
  strategy        TEXT NOT NULL,
  buy_station_id  INTEGER NOT NULL,
  sell_station_id INTEGER NOT NULL,
  suggested_buy   REAL NOT NULL,
  suggested_qty   INTEGER NOT NULL,
  suggested_sell  REAL NOT NULL,
  estimated_fees  REAL NOT NULL,
  hauling_cost    REAL NOT NULL DEFAULT 0,
  expected_profit REAL NOT NULL,
  expected_roi    REAL NOT NULL,
  capital_required REAL NOT NULL,
  turnover_hours  REAL,
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'rejected', 'executed_manually', 'expired')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at      TEXT NOT NULL,
  executed_at     TEXT,
  actual_buy_price REAL,
  actual_sell_price REAL,
  actual_profit   REAL
);

-- 4. 历史回测结果记录表
CREATE TABLE IF NOT EXISTS backtest_runs (
  run_id          TEXT PRIMARY KEY,
  strategy_name   TEXT NOT NULL,
  time_horizon    TEXT NOT NULL,
  initial_capital REAL NOT NULL,
  final_capital   REAL NOT NULL,
  total_roi_pct   REAL NOT NULL,
  max_drawdown_pct REAL NOT NULL,
  sharpe_ratio    REAL,
  win_rate_pct    REAL NOT NULL,
  trade_count     INTEGER NOT NULL,
  fee_drag_pct    REAL NOT NULL,
  metrics_json    TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
```
