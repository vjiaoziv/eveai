# EVEAI 投资交易系统数据字典说明书
**文档编号**：`TRADING_DATA_DICTIONARY.md`  
**数据库引擎**：SQLite 3 (WAL 模式)  
**文件路径**：`./data/eve-agent.db`  
**基准日期**：2026-11-02

---

## 一、新增投资系统核心业务表

### 1. `data_source_status` (数据源监控与健康状态表)
| 字段名 | 数据类型 | 约束 | 释义与业务规范 |
| :--- | :--- | :--- | :--- |
| `source_id` | TEXT | PRIMARY KEY | 数据源唯一标识（如 `ccp_esi_orders`, `fuzzwork`, `sde_local`） |
| `status` | TEXT | NOT NULL | 状态：`ok`（正常）, `degraded`（降级/部分超时）, `offline`（离线） |
| `last_success_at`| TEXT | NULL | 最后一次成功拉取数据的 UTC 时间戳 |
| `last_error` | TEXT | NULL | 最近一次异常的具体报错信息摘要 |
| `error_count_1h` | INTEGER | DEFAULT 0 | 过去 1 小时内累计发生的请求失败次数 |
| `updated_at` | TEXT | DEFAULT now | 记录更新时间 |

### 2. `portfolio_positions` (投资组合与持仓资产表)
| 字段名 | 数据类型 | 约束 | 释义与业务规范 |
| :--- | :--- | :--- | :--- |
| `position_id` | TEXT | PRIMARY KEY | 头寸唯一编号（如 `POS-2026-0001`） |
| `character_id` | INTEGER | NOT NULL | 关联的 EVE 角色 Character ID |
| `type_id` | INTEGER | NOT NULL | 标的物品 Type ID（外键关联 `sde_types`） |
| `location_id` | INTEGER | NOT NULL | 当前货物堆存的空间站 Station ID 或建筑 ID |
| `quantity` | INTEGER | NOT NULL | 当前持仓剩余件数 |
| `cost_basis` | REAL | NOT NULL | 单件采购加权综合成本（含买入端税费） |
| `current_price` | REAL | NULL | 当前最新公允买单变现估价 |
| `unrealized_pnl` | REAL | NULL | 浮动未实现盈亏（当前估值扣除销售税后减去成本） |
| `strategy_type` | TEXT | NOT NULL | 所属策略：`station_arbitrage` / `regional_hauling` / `trend` |
| `status` | TEXT | DEFAULT 'open'| 状态：`open`（持仓中）, `partial`（部分平仓）, `closed`（已全部出清） |
| `opened_at` | TEXT | DEFAULT now | 开仓时间 |
| `closed_at` | TEXT | NULL | 完全出清平仓时间 |

### 3. `trade_drafts` (交易订单草案决策表)
| 字段名 | 数据类型 | 约束 | 释义与业务规范 |
| :--- | :--- | :--- | :--- |
| `draft_id` | TEXT | PRIMARY KEY | 草案唯一编号（格式：`TR-YYYY-NNNNNN`，如 `TR-2026-000001`） |
| `character_id` | INTEGER | NOT NULL | 所属飞行员 Character ID |
| `type_id` | INTEGER | NOT NULL | 交易标的 Type ID |
| `strategy` | TEXT | NOT NULL | 对应策略类型 |
| `buy_station_id` | INTEGER | NOT NULL | 建议买入采购空间站 ID |
| `sell_station_id`| INTEGER | NOT NULL | 建议卖出出货空间站 ID |
| `suggested_buy` | REAL | NOT NULL | 建议买入价格（挂单买价或卖单最低出厂价） |
| `suggested_qty` | INTEGER | NOT NULL | 建议采购数量（严格经资金与货运容量裁剪） |
| `suggested_sell`| REAL | NOT NULL | 建议卖出价格（目标站买单即时变现价或推荐卖单挂牌价） |
| `estimated_fees`| REAL | NOT NULL | 确定性费用引擎算出的双边税费总和（经纪人费+销售税） |
| `haulingCost` | REAL | DEFAULT 0 | 运输成本与物流消耗估算 |
| `expected_profit`| REAL | NOT NULL | 预期净利润（净收入扣除净成本与税费） |
| `expected_roi` | REAL | NOT NULL | 预期净资本回报率（ROI %） |
| `capital_required`| REAL | NOT NULL | 启动该笔交易所必需的净现金占用 |
| `turnover_hours`| REAL | NULL | 预估资金占用与库存周转小时数 |
| `status` | TEXT | DEFAULT 'draft'| 状态：`draft`, `approved`, `rejected`, `executed_manually`, `expired`, `closed` |
| `created_at` | TEXT | DEFAULT now | 草案生成时间 |
| `expires_at` | TEXT | NOT NULL | 草案有效截止时间（默认 24 小时过期） |
| `actual_buy_price`| REAL | NULL | 飞行员手动录入的游戏内真实买入成交单价 |
| `actual_sell_price`| REAL | NULL | 飞行员手动录入的游戏内真实卖出成交单价 |
| `actual_profit` | REAL | NULL | 基于真实成交价计算的最终实际盈亏 |

### 4. `trade_ledger` (实际交易操作台账审计表)
| 字段名 | 数据类型 | 约束 | 释义与业务规范 |
| :--- | :--- | :--- | :--- |
| `ledger_id` | INTEGER | PK AUTOINCREMENT | 账本流水自增主键 |
| `draft_id` | TEXT | NULL | 关联的订单草案编号（可选） |
| `character_id` | INTEGER | NOT NULL | 操作角色 ID |
| `type_id` | INTEGER | NOT NULL | 交易物品 Type ID |
| `action` | TEXT | NOT NULL | 动作：`buy`, `sell`, `reprocess`, `broker_fee`, `sales_tax` |
| `quantity` | INTEGER | NOT NULL | 交易数量 |
| `price` | REAL | NOT NULL | 交易成交单价 |
| `fees` | REAL | DEFAULT 0 | 产生的实际税费扣款 |
| `timestamp` | TEXT | DEFAULT now | 发生时间 |
| `notes` | TEXT | NULL | 备注说明 |

---

## 二、复用与扩充的现有数据表

1. **`market_orders`**：存储 155.8 万条全宇宙实时挂单快照，索引为 `location_id`, `type_id`, `is_buy_order`。
2. **`market_price_history`**：存储各星域 `(region_id, type_id, date)` 的官方每日交易成交均价、高低位与成交量（Volume）。
3. **`character_wallet` / `character_assets`**：用于动态校准飞行员资产与可用资金。
4. **`sde_types`**：物品静态表，包含 `zh_name` 中文虚拟列与二级索引。
