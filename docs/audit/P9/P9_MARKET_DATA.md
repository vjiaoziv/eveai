# P9 Market Data

## 数据源

第一阶段只使用本地公共 ESI 区域订单簿快照：

- `market_orders`
- `market_snapshot_regions`
- `market_snapshot_state`
- SDE 商品、组、类别、空间站

现有 worker `src/eve/market-snapshot.ts` 周期刷新 k-space 区域订单；P9 扫描不直接制造高频 ESI 请求。

## 扫描地点

默认白名单：

1. Jita IV-4（60003760 / The Forge 10000002）
2. Amarr VIII（60008494 / Domain 10000043）
3. Dodixie IX-20（60011866 / Sinq Laison 10000032）

可通过“系统设置”增删、启用或禁用，不硬编码单一地点。保存时用当前 SDE 校验区域 ID 存在、NPC 空间站实际所属区域一致（非 SDE 玩家建筑允许加入，但会标记 `STRUCTURE_OR_UNKNOWN_LOCATION`）。

## 扫描字段

每条机会保存：

- Type ID、中英文名
- 买卖地点与区域
- 买卖加权成交价和逐档原始报价
- 建议数量、可执行数量
- 采购金额、销售收入
- 经纪人费、销售税、其他费用
- 四层利润
- 资金占用、ROI、物流成本
- 买卖快照 ID、时间、年龄
- 数据来源、完整性、新鲜度
- 风险等级、风险标记
- 计算版本、发现/更新/失效时间

## 覆盖声明

原始快照 JSON 明确写入：

`public ESI regional market orders; contracts, private structures and unobserved orders are not assumed absent`

处理规则：

- ESI 公共订单：作为可观察订单簿。
- 地点不在 SDE 空间站表：标记 `STRUCTURE_OR_UNKNOWN_LOCATION`。
- 区域快照有错误或未加载：`DATA_INCOMPLETE`。
- 快照实际年龄超过用户配置的 `maxMarketAgeMinutes`：`DATA_STALE`，机会状态 `STALE`。ESI `Expires` 头只约束重新抓取时机，不单独作为行情失效条件（2026-11-03 修正：此前 ESI 缓存过期即判陈旧，导致刚抓取的区域被误标 `STALE`）。
- 未观察到订单：只代表本次公共快照未观察到，不代表市场绝对不存在。

## 两类套利

### 站内套利

同一地点逐档吃卖单、卖给买单，物流成本为 0；综合净利润仍可能因库存/资金占用保持 UNKNOWN。

### 跨贸易中心套利

分别分析买入和卖出订单簿。`logisticsCost = null`，`comprehensiveStatus = UNKNOWN`，风险含 `LOGISTICS_UNKNOWN`。费用后净利润明确不是最终可实现利润。

## 2026-11-03 真实 ESI 运行记录

在隔离数据库副本 `data/verify-p9.db` 上执行完整真实链路（不改动生产库）：

- `market-snapshot-loader` 真实抓取：68 个 k-space 贸易区域、1,558,512 行订单、耗时 210.4 秒、0 区域错误、0 畸形行。
- P9 扫描（默认阈值：费后净利润 ≥100,000 ISK、ROI ≥5%、资金 ≤100,000,000 ISK）：候选 522 个，入库 100 个机会。
- 结果：71 个 `ACTIONABLE`、29 个 `REJECTED`（低于阈值）；全部为跨贸易中心套利，均含 `LOGISTICS_UNKNOWN`，综合净利润保持 `UNKNOWN`。
- 站内套利：对三个贸易中心分别执行 SQL 复核，同地点“买单价 > 卖单价”的交叉订单数均为 0，与 EVE 撮合机制一致；算法运行正常但本轮没有可报的站内机会，如实记为 0，不伪造数据。
