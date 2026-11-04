# 代码与数据库审计报告

## 1. 基线和工作区

**已通过代码验证**

- 权威仓库为 `/home/ubuntu/projects/eveai`，分支 `deploy/eve-ai-agent`。
- 审计开始时 HEAD 为 `6d78d59`，该提交是 P9.2 最终提交，不是 P9.3 提交。
- P9.3 代码、测试、迁移和文档均处于未提交工作区；不存在可核实的“P9.3 最终提交”。
- 审计和修复过程中保留了原有未提交修改，没有 reset、checkout 或覆盖用户工作区。

## 2. 数据库结构与迁移

**已通过真实环境验证**

权威数据库为 `data/eve-agent.db`。迁移前已通过 better-sqlite3 在线备份生成：

- `data/backups/eve-agent.db.bak_20261103_p931_pre`
- 大小：1,137,184,768 bytes
- 备份数据库 `PRAGMA integrity_check = ok`

执行 `npm run db:migrate` 后：

- `P93AuditService.integrityCheck`：`ok: true`，无 findings。
- SQLite `integrity_check`：`ok`。
- 生产服务 `/health`：HTTP 200，database `ok`。

本次迁移只涉及 schema、index 和 trigger，不删除或改写真实交易历史。迁移前后交易事实表仍为：

| 表 | 行数 |
|---|---:|
| `real_trade_records` | 0 |
| `real_trade_events` | 0 |
| `real_trade_evidence` | 0 |
| `real_fifo_lots` | 0 |
| `real_fifo_consumptions` | 0 |

## 3. P9.3 表与关键约束

**已通过代码验证**

- `real_trade_records`：REAL 交易主表，`is_paper = 0` CHECK，`ledger_key` 按角色唯一，数量/价格/费率有 CHECK。
- `real_trade_events`：追加式审计事件。
- `real_trade_fees`：费用及处理口径。
- `real_trade_evidence` / `real_trade_evidence_links`：证据和多关系关联。
- `real_fifo_lots` / `real_fifo_consumptions`：FIFO 派生批次与消耗。
- `real_calculation_runs`：核算版本、前后哈希和差异。
- `real_reconciliation_runs/items/cases`：真实资产对账结果及人工案例。
- `real_esi_transaction_sync`：ESI 钱包交易游标。

审计后要求并通过生产库核验的 16 个财务触发器包括：

- 交易记录不可删除、非草稿事实不可覆盖、禁止直接插入 VERIFIED。
- VERIFIED 必须存在同角色且与事实匹配的已核实证据。
- 冲突证据阻止核实。
- 费用仅允许在 DRAFT 状态新增/修改/删除。
- 已核实或终态记录的证据关系不可变更。
- 财务事件只追加，且必须关联同角色交易记录。
- 已核实证据不可覆盖或删除。

`idx_real_fifo_consumptions_unique_consumption` 在 `(sell_record_id, lot_id)` 上唯一，防止同一卖出重复消耗同一批次。

## 4. 审计发现及修复

### 4.1 ESI 钱包同步错误字段

**已通过隔离测试数据验证**

原实现读取钱包交易的 `row.price`，实际 ESI 合约字段为 `unit_price`。这会导致真实 ESI 钱包交易单价被解析为 `NaN`，从而无法导入。

已修复：

- `normalizeEsiWalletTransaction()` 优先读取 `unit_price`，兼容 `price`。
- 隔离测试验证 `unit_price = 12.34` 被正确保留。

### 4.2 ESI 钱包证据自动核实交易

**已通过隔离测试数据验证**

原实现把 ESI 钱包交易关联为 PRIMARY 后立即用系统身份核实交易，违反“钱包日志关联不等于交易事实已经充分核实”。

已修复：

- ESI 同步只建立原始交易和来源证据，不自动核实交易。
- 交易核实必须由明确的人类 `user:<id>` 身份调用。
- 钱包证据只有在证据状态 VERIFIED、来源为 `ESI_WALLET_TRANSACTIONS` 且 `source_ref` 完全匹配时才可作为匹配证据。

### 4.3 公共证据接口可自证 VERIFIED

**已通过代码验证**

原公共证据登记接口接受 `initialStatus: VERIFIED`，用户可先自证证据再核实交易。

已修复：

- 公共 `POST /evidence` 固定以 `PENDING` 登记。
- 证据核实改为独立的 `POST /evidence/:evidenceId/status` 人类操作，并记录审计事件。
- 前端证据页面增加“核实证据/驳回证据”，不再在登记时直选 VERIFIED。

### 4.4 证据类型与交易事实错误匹配

**已通过隔离测试数据验证**

- `ESI_MARKET_ORDER` 只能证明订单存在，不能单独证明成交。
- `ESI_ASSET_SNAPSHOT` 和 `ASSET_CHANGE` 不能单独证明买卖成交。
- 当前核实门禁只接受人工附件/人工确认，或与 ESI 钱包交易来源引用完全匹配的钱包证据。
- 已核实或冲突证据存在时，交易不能被升级为 VERIFIED。
- 数据库触发器同样阻止无匹配证据的直接 SQL 核实。

### 4.5 sourceHash 与草稿修改

**已通过隔离测试数据验证**

原实现信任调用方提供的 `sourceHash`，且草稿修改后不重算哈希，可能绕过幂等冲突。

已修复：

- `sourceHash` 由规范化交易事实计算；调用方提供的哈希不一致时拒绝。
- 哈希覆盖交易类型、方向、数量、单价、时间、来源、订单/成交引用、费用、地点和调整字段。
- `updateDraft` 重新计算 `source_hash`。
- 隔离测试验证草稿修改后重放旧事实会被拒绝。

### 4.6 旧 P9 REAL 账本与接口并存

**已通过代码验证**

原工作区同时存在：

- 旧 `p9_real_trades` / `p9_inventory_lots` / `p9_inventory_moves`。
- 新 P9.3 `real_trade_records` / FIFO 表。
- 旧 `/api/web/trading/p9/real-trades`、`/inventory/lots`、`/esi-sync`、`/rebuild-ledger` 写接口仍挂载。
- 旧仪表盘和 AI 分析仍读取旧账本。

这会造成两套 REAL 账本和两套盈亏口径。

已修复：

- 旧真实交易/库存写接口以及旧 `/real-trades` 读接口返回 HTTP 410，指向 `/api/web/trading/p9/real-ledger`。
- P9 交易工作台默认进入 P9.3 `REAL 账本`，隐藏旧账本视图。
- P9 总览的财务指标改为读取 P9.3 FIFO/performance。
- AI 分析改为读取 `real_trade_records` 及 P9.3 确定性 performance/unrealized 数据。
- 旧表暂不物理删除，保留历史兼容和后续人工清理决策空间。

### 4.7 FIFO 精度、转移和重复消耗

**已通过隔离测试数据验证**

修复包括：

- 单位成本保留 8 位精度，货币结果按分取整。
- 卖出成本从批次剩余成本按数量分配，最终批次吸收余差，避免重复小数舍入。
- 卖出费用按批次分配，最终批次吸收费用余差。
- 支持已核实 INVENTORY_TRANSFER 在同角色、同物品的 FIFO 批次间移动，支持部分批次拆分。
- 唯一索引阻止同一卖出重复消耗同一批 lot。
- `after_hash` 排除随机 ID/创建时间，仅覆盖稳定业务字段；未变化的重复重算得到相同哈希。
- 成本调整不得把批次成本降为负数；UNKNOWN 成本不会被升级为 KNOWN。

### 4.8 盈亏计算

**已通过隔离测试数据验证**

- `totalFees` 在存在 UNKNOWN 费用时为 `null`，不再显示为 0。
- 盈利交易比例按“卖出交易记录”聚合，而不是按消耗批次数量相除。
- UNKNOWN 成本批次保持 `null` 结果，不强制为零。
- 未实现盈亏只使用与最新完整资产快照对应的最新估值，不混用旧快照估值。
- 库存数量与估值数量不一致时返回 `N/A_QUANTITY_MISMATCH`。

### 4.9 对账状态和重复检测

**已通过隔离测试数据验证**

- 对账组状态现在同时考虑资产变化/重复来源产生的未结案例。
- 重复来源检测排除 REJECTED、REVERSED、CORRECTED，避免更正链被误报为重复。
- 资产变化只产生复核案例，不自动生成交易。
- 估值查询绑定当前对账快照，防止 item_id 碰撞导致混用旧估值。

### 4.10 SSE 迟到关闭处理

**已通过隔离测试数据验证**

`perimeter-radar` 调查发现 SseStream 在 close 已经发生、随后才注册 `onClose` 时不会执行清理，可能泄漏 live poller、timer、audience 和 advisor ref。

已修复：`onClose` 对已关闭 stream 立即执行 handler。测试也改为等待 READY、用可观察状态替代固定时间断言，并在 teardown 关闭所有 SSE client。

## 5. 结论

- 结构、迁移、约束和修补后的关键执行路径：**已通过代码验证**。
- 主要财务路径和边界：**已通过隔离测试数据验证**。
- 生产库迁移、触发器、索引和完整性：**已通过真实环境验证**。
- 真实交易样本相关结论：**尚未验证**。