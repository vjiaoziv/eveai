# EVEAI 市场数据来源与合规调用规范
**文档编号**：`MARKET_DATA_SOURCES.md`  
**基准日期**：2026-11-02  
**规范定位**：界定 EVE Online 投资系统中各数据源的采集途径、刷新策略、错误处理与降级机制。

---

## 一、官方 EVE Swagger Interface (ESI)

- **服务域名**：`https://esi.evetech.net/latest/`
- **连通策略**：通过本地代理分发器 (`http://127.0.0.1:8033`) 实现跨国网关穿透。
- **核心数据通道**：
  1. **全星域订单漫游 (`/markets/{region_id}/orders/`)**：
     - 分页拉取（每页 1,000 条），主要贸易星域（The Forge, Domain, Sinq Laison, Metropolis, Heimatar）高频漫游；
     - 严格遵守 5 分钟官方强缓存，依据 `ETag` 判定 304 未修改，避免重复拉取。
  2. **历史日线行情 (`/markets/{region_id}/history/`)**：
     - 提供近 400 天的官方每日真实成交量、成交单数与加权均价；
     - 每日 11:00 UTC（服务器例行维护后）刷新一次。
  3. **私人角色数据接口 (`/characters/{id}/*`)**：
     - 包含资产（60 分钟缓存）、钱包余额（2 分钟缓存）、个人订单与技能。
- **调用合规与安全熔断**：
  - 严格限制并发数在 12 以内；
  - 监控响应头 `X-Esi-Error-Limit-Remain`，低于 30 时触发主动休眠保护；
  - 发生网络抖动时执行 1s ➔ 2s ➔ 4s 指数退避，上限 30s。

---

## 二、官方静态数据导出 (EVE SDE)

- **本地存储位置**：`./data/sde/` 与 `./data/eve-agent.db`
- **构建版本**：CCP 官方 2026-10 最新 JSONL 全量格式。
- **包含内容**：
  - `sde_types` (53,299 项道具)，包含官方中文名称、体积、质量与基础出厂价；
  - `sde_systems` (8,490 个星系) 与 `sde_stargates`，用于准确推演星系安全等级与跳数；
  - `sde_type_materials`，记录舰船、装备再处理（Reprocessing）拆解出三钛等基础矿物的精准物料清单。
- **免维护性**：完全脱机运行，0 毫秒响应，无任何网络风控与鉴权依赖。

---

## 三、第三方校验与归档数据源

1. **Fuzzwork Market API (`https://market.fuzzwork.co.uk/`)**：
   - 用途：快速获取指定物品在各大枢纽的聚合均价与深度，作为 ESI 订单漫游异常时的交叉验证依据。
   - 限制：单次请求控制在 100 个 type_id 以内，并发限制为 2。
2. **EVE Ref (`https://data.everef.net/`)**：
   - 用途：作为历史订单簿回测数据归档源，支持批量导入历史日度订单切片进行回测复盘。
3. **EVE-KILL / zKillboard (`src/eve-kill/`)**：
   - 用途：跟踪高安航线咽喉星系（如 Uedama、Sivala）的 1 小时战损事件与活跃海盗，为跨区航运提供实时的航线危险度加权。
