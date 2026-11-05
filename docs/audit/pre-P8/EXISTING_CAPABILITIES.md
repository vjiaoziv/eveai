# EVEAI 现有功能能力清单与成熟度评级
**文件编号**：`EXISTING_CAPABILITIES.md`  
**基准日期**：2026-11-02  
**评级体系**：
- **【已实现】**：功能完整、经实测可用，可直接复用；
- **【部分实现】**：底层接口或数据结构已具备，缺少上层业务封装；
- **【未实现】**：项目当前完全缺失该功能，需从零编写；
- **【实现存在问题】**：现有代码存在逻辑缺陷、硬编码或性能瓶颈，需重构；
- **【需要进一步验证】**：代码已编写但受限于特定网络、环境或第三方服务，需加固验证。

---

## 核心功能清单逐项评估

| 序号 | 需求功能点 | 现有状态 | 源码位置与数据载体 | 现状分析与改造计划 |
| :---: | :--- | :---: | :--- | :--- |
| **1** | **角色钱包读取** | **【已实现】** | `src/eve/character-sync.ts`<br>表：`character_wallet`, `character_wallet_journal` | **实测确认**：已读取角色 `JIEAOZVI` 当前余额为 `68,318,340.97 ISK`。具备账单流水同步。可直接复用为 P4 动态资金源。 |
| **2** | **角色资产读取** | **【已实现】** | `src/eve/character-sync.ts`, `src/eve/assets-summary.ts`<br>表：`character_assets` | **实测确认**：已同步 451 项个人资产，支持递归解析容器树（机库、货柜、挂载装备、单件/打包）。可直接复用。 |
| **3** | **角色市场订单读取** | **【已实现】** | `src/eve/character-sync.ts`, `src/eve/orders-summary.ts`<br>表：`character_orders` | 已支持通过 ESI 同步个人挂单（卖单与买单）、托管资金（Escrow）与到期时间。在 P4 中直接用于统计已锁定资金。 |
| **4** | **市场订单查询** | **【已实现】** | `src/eve/market-queries.ts`, `src/eve/market-snapshot-loader.ts`<br>表：`market_orders` | **实测确认**：本地存有 155.8 万条全宇宙挂单，支持按空间站、星域、买卖方向过滤。包含吉他 4-4 (32.6万条)、杜迪克西 (6.8万条) 等。 |
| **5** | **历史成交数据** | **【部分实现】** | `src/eve/market-history.ts`, `src/eve/market-history-worker.ts`<br>表：`market_price_history`, `market_history_sync` | 表结构完整，具备抓取 `/markets/{region_id}/history/` 的后台 Worker；目前默认仅为自选清单和告警物品抓取。需扩展为支持全品类批量抓取与归档。 |
| **6** | **市场价格统计** | **【已实现】** | `src/eve/market-history.ts` (`computeHistoryStats`) | 算法已实现：计算 7d/30d/90d 均价、对数收益波动率、日均成交量（Volume）与价格趋势斜率。计算结果严密，可直接调用。 |
| **7** | **物品 SDE 数据** | **【已实现】** | `src/eve/sde.ts`, `src/eve/sde-loader.ts`<br>表：`sde_types`, `sde_groups`, `sde_type_materials` 等 | **实测确认**：5.3 万个物品与 8,490 个星系已就绪，添加了 `zh_name` 虚拟生成列与二级索引，支持 0 毫秒中英文双向互查。 |
| **8** | **市场订单深度** | **【部分实现】** | `src/eve/market-agent-tools.ts` (`fill` 函数) | `fill(orders, quantity)` 已实现单边买卖订单逐档穿透计算加权平均价；但目前仅在单点查询时被触发，未接入套利扫描与投资决策引擎。 |
| **9** | **数据定时同步** | **【已实现】** | `src/eve/market-snapshot.ts`, `src/eve/market-alerts-worker.ts` | 具备后台自动轮询机制，主要星域 30 分钟刷新，次要星域 360 分钟刷新，符合 ESI 官方 5 分钟缓存规范。 |
| **10**| **价格趋势分析** | **【部分实现】** | `src/eve/market-history.ts` | 能够输出数学统计趋势，但尚未实现基于供需关系、版本改动与事件驱动的情报分析（属于 P5 规划范围）。 |
| **11**| **交易费用计算** | **【实现存在问题】** | `src/eve/` 散落的硬编码估算 | **问题所在**：现有代码采用固定的 3.6% 销售税或 1% 估值，未读取角色实际“会计学”与“经纪人关系”技能等级，未考虑玩家建筑与声望减免，需重构为确定性精算引擎。 |
| **12**| **市场数据缓存** | **【已实现】** | SQLite WAL 模式 + `src/eve/esi-catalog.ts` | ESI 规范的 ETag 与 Expires 缓存管理已完备，具备防重复请求机制。 |

---

## 结论与复用策略
1. **直接复用（占比 60%）**：角色数据读取（钱包、资产、订单）、SDE 中英文查询底座、全宇宙订单簿快照采集器与数据库存储拓扑。
2. **重点重构（占比 15%）**：将分散且带有硬编码的税费逻辑重构为**确定性费用引擎 (`FeeEngine`)**，支持 Alpha/Omega 技能与声望参数化。
3. **新增模块（占比 25%）**：
   - 跨区域/站内双模套利扫描器 (`ArbitrageScanner`)；
   - 动态资金分配与投资组合风险控制器 (`PortfolioRiskManager`)；
   - 订单草案生成与人工确认追踪系统 (`TradeDraftSystem`)；
   - 历史回测与模拟撮合引擎 (`BacktestingEngine`)。
