# EVEAI 市场投资与交易决策系统技术架构说明书
**文档编号**：`TRADING_SYSTEM_ARCHITECTURE.md`  
**版本**：v1.0.0 (2026-11-02)  
**系统定位**：基于 EVE Online 全域实时市场数据、官方 SDE 数据库与经济学量化模型的专业交易与投资决策 Agent。

---

## 一、架构全景与分层设计

系统整体采用分层解耦架构，自下而上划分为：**数据持久化层**、**数据集成与清洗层**、**核心精算与撮合引擎层**、**策略扫描与风控层**、**交易草案与台账层**、**应用表现层 (Web/CLI/Agent)**。

```
[ 表现层 (Presentation Layer) ]
  ├── Web 管理面板 (Fastify 5 + React 19 SPA, 476词条中文化)
  ├── 跨平台 CLI 工具 (eve-agent 全局指令，接入 Windows PATH)
  └── Agent 技能接口 (Codex / Hermes / dsh 原生 SKILL.md)
                         │
                         ▼
[ 决策与风控层 (Decision & Risk Layer) ]
  ├── 动态资金状态机 (PortfolioManager: 20% 储备金, 15% 单品限额, 5000万防强杀)
  ├── 订单草案系统 (DraftSystem: TR-YYYY-NNNNNN 全生命周期管理)
  └── 交易台账 (TradeLedger: 记录采购、销售、税费审计流水)
                         │
                         ▼
[ 策略分析层 (Strategy Engine Layer) ]
  ├── 站内价差套利 (StationArbitrageStrategy: 买单吃进/就地挂卖单)
  ├── 跨贸易中心高安航运 (RegionalHaulingStrategy: 吉他➔杜迪克西15跳/赫克19跳)
  ├── 产业链拆解套利 (ManufacturingArbitrageStrategy: SDE 矿石与装备解体比价)
  ├── 趋势跟踪与动量 (TrendAnalysisStrategy: 7/14/30/90日均线与分位数)
  ├── 事件驱动分析 (EventDrivenStrategy: 版本更新与供需冲击推演)
  └── 历史回测引擎 (BacktestingEngine: 严格无未来数据的时间步推进撮合)
                         │
                         ▼
[ 核心计算与撮合层 (Calculation & Simulation Layer) ]
  ├── 确定性费用引擎 (FeeEngine: Alpha/Omega 会计学、经纪人关系、声望与改单税)
  └── 订单簿深度模拟器 (OrderBookSimulator: 逐档穿透、加权平均价、滑点与截断)
                         │
                         ▼
[ 数据集成与访问层 (Data Center & Integration Layer) ]
  ├── 数据中心控制器 (DataCenter: 多数据源健康监控 data_source_status)
  ├── 官方 ESI 实时客户端 (支持全局本地代理分发器与 100/min 错误限额熔断)
  └── 静态 SDE 数据访问 (sde_types 虚拟列 zh_name 与二级索引支持 0ms 检索)
                         │
                         ▼
[ 持久化存储层 (Persistence Layer) ]
  └── SQLite 3 (/data/eve-agent.db: WAL 模式，常驻 155.8 万条全域订单与 SDE 库)
```

---

## 二、模块职责与接口契约

### 1. `FeeEngine` (确定性费用精算引擎)
- **职责**：将所有交易手续费的计算从大模型中剥离，交由确定性数学代码执行。
- **核心公式**：
  - 销售税：$\text{SalesTaxRate} = 8.0\% \times (1 - 0.11 \times \text{AccountingLevel})$
  - 经纪人费：$\text{BrokerFeeRate} = 3.0\% - 0.3\% \times \text{BrokerRelationsLevel} - 0.03\% \times \text{FactionStanding} - 0.02\% \times \text{CorpStanding}$（NPC 站最低保底 1.0%）
- **输出**：买入/卖出端经纪人费、销售税、总费用、净利润、净利润率、ROI 及精确保本售价。

### 2. `OrderBookSimulator` (订单簿撮合模拟器)
- **职责**：真实模拟采购与变现时的市场深度消耗。
- **机制**：买入时按价格升序逐档消耗卖单，卖出时按价格降序逐档消耗买单；计算加权均价、滑点百分比以及深度耗尽时的部分成交结果。

### 3. `PortfolioManager` (动态资金风控状态机)
- **职责**：与飞行员当前实际钱包现金（6,831 万 ISK）及买单锁定金（Escrow）实时联动。
- **风控阈值**：
  - 强制冻结 20% 现金储备底线，任何策略均不可动用；
  - 单一物品持仓限额 $\le 15\%$，单一品类限额 $\le 30\%$；
  - T1 工业舰高安航运货值上限 $\le 5,000$ 万 ISK。

### 4. `DraftSystem` (交易草案系统)
- **职责**：将策略发现的机会转化为标准格式订单草案（`TR-YYYY-NNNNNN`）。
- **状态转移**：`draft` ➔ `approved` ➔ `executed_manually` ➔ `closed`（或 `rejected` / `expired`）。
- **人工闭环**：系统仅输出参数指引，100% 由飞行员在 EVE 客户端手动执行下单。

---

## 三、部署拓扑与进程生命周期

1. **WSL2 常驻运行**：Ubuntu 24.04 实例迁移至 `D:\WSL\Ubuntu-24.04\ext4.vhdx`，配置 `networkingMode=mirrored` 与 `vmIdleTimeout=-1` 确保后台永久不休眠。
2. **系统守护进程**：由 `systemd` 管理 `eveai.service`，监听 `127.0.0.1:3000`，具备自动崩溃重启与优雅停机排空（Drain）。
3. **全局命令行接入**：Windows 原生路径 `C:\Users\JIAOZI\bin\eve-agent.cmd` 桥接 WSL，支持任何终端与 IDE 快速调用。
