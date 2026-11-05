# 01 修复设计

## 1. 范围

P9.3.3.8 是对 P9.3.3 钱包同步、REAL 账本授权、资产镜像隔离和 FIFO 财务口径的补强。目标不是新增真实交易能力，而是消除已复现的跨所有者读写、游标越界、UNKNOWN 成本污染、镜像串线和分页静默截断。

本阶段未启动 P9.4，未部署，未访问生产数据库。

## 2. 修复前问题链

### F-P9337-01：REAL 账本只有 character_id 边界

复现：同一 EVE 角色从一个本地所有者转移给另一个本地所有者后，新所有者仍能按 `character_id` 读取、冲正或更正旧所有者的 REAL 账本记录。

根因：账本主键和多数查询只使用 `character_id`；`binding_digest` 若只由当前授权快照计算，会被普通 scope refresh 改变，不适合作为持久授权条件。

### F-P9337-02：资产镜像跨 chat lane 删除

复现：同一角色在 chat B 发起资产同步时，旧写入路径按 `character_id` 删除或覆盖 chat A 的镜像。

根因：`character_assets` 主键和删除条件没有 owner/chat/epoch。

### F-P9337-03：聚合数量相同即误报完整

复现：两个不同 item set 具有相同的 type/location/quantity 汇总时，完整性检查仍返回 `COMPLETE`。

根因：只比较聚合计数，没有比较规范化的 item-set 哈希。

### F-P9337-04：快照详情静默截断

复现：快照超过 5000 个 item 时，详情接口只返回前 5000 行，调用方没有 `total`、`hasMore` 或 `nextOffset` 信号。

根因：单次查询硬上限且缺少分页契约。

### F-P9337-05：钱包游标跨所有权继承

复现：所有者 A 的游标为较高 transaction_id 后，所有者 B 绑定同一角色并持有较低 ID 的交易，新所有者同步跳过该交易。

根因：游标表只有 character_id 或游标读取没有持久 owner/chat/epoch 维度。

五项缺陷均已在 `tests/audit/p9-3.3.7/` 的修复前反例中复现，日志为 `logs/00-baseline-p9337-reproduction.log`。

## 3. 设计决策

### 3.1 持久所有权信封

REAL 账本和 P9 控制面统一使用：

```text
character_id + owner_user_id + owner_chat_id + binding_epoch
```

- `character_id` 标识 EVE 角色，不作为本地授权边界。
- `owner_user_id` 是持久所有者。
- `owner_chat_id` 是持久操作 lane；无 chat 时使用 NULL 哨兵。
- `binding_epoch` 在重新绑定或所有权变化时递增。
- `binding_digest` 只记录写入时的授权快照证据，不参与正常读取授权，避免 scope refresh 隐藏同一所有者历史。

旧数据保留为：

```text
owner_user_id IS NULL
owner_chat_id IS NULL
binding_epoch = 0
```

迁移不把旧数据自动归属于当前绑定者。

### 3.2 写入前后双重校验

写路径在 `BEGIN IMMEDIATE` 内重新解析当前绑定并比较 owner/chat/epoch；写入后、提交前再次校验。角色解绑、所有权变化或 epoch 变化会使事务回滚。

### 3.3 钱包同步固定角色

Web 路由先解析目标角色和 lineage，然后把显式 `characterId`、owner、chat 和 epoch 传给服务。服务再次固定上下文，不重新使用“当前活动角色”作为后续写入目标。ESI path、token、证据、账本记录、游标和错误状态使用同一个角色身份。

### 3.4 能力快照和 scope

钱包同步在 ESI 调用前主动调用 `getEveCapabilities()`，检查：

```text
esi-wallet.read_character_wallet.v1
```

缺少 scope 时返回可操作的 `WALLET_SCOPE_MISSING`，且不发起私有钱包请求；能力快照过期时重新建立。

### 3.5 保守游标和持久失败记录

- 对一条交易的处理失败会写入 `real_esi_transaction_failures`。
- 只要当前同步边界内存在未解决失败，游标不推进。
- 低 ID 失败、高 ID 成功时，游标停留在最后一次安全边界。
- 低 ID 的临时失败在下次同步可重放。
- `ledgerKey = esi-wallet:<transaction_id>`、source reference 和证据哈希提供幂等重试。
- 完整分页和完整字段验证发生在任何账本提交之前。

### 3.6 FIFO 财务口径

分别统计：

- `unknownConsumptionCount`：已卖出、成本无法确定的 FIFO 消耗。
- `unknownOpenLotCount`：仍未售出的 UNKNOWN 成本 lot。

`realizedPnl` 仅由已售消耗决定；未售 UNKNOWN 不污染它。`knownRealizedPnl` 保留可确定部分。胜率只统计成本完整可确定的卖出交易。库存成本和资金占用仍对开放 UNKNOWN 批次返回 N/A。

### 3.7 新鲜度

比较最近的 REAL 账本事实/证据变化时间与最近成功 FIFO 计算时间：

- 无成功计算：`NEVER_CALCULATED`。
- 账本事实晚于计算：`STALE`。
- 最近计算失败且旧成功结果仍存在：`STALE`。
- 仅在成功重算后恢复 `CURRENT`。

不自动高频重算。

### 3.8 角色资料同步

- 钱包余额必须是有限非负数；非法值使 dataset 失败，保留旧有效余额。
- `character_sync_state` 的 `synced_at`/`rows_synced` 只描述最近一次成功同步；错误状态单独保存。
- 资产同步委派 P9.2 `RealAssetSyncService`，先完成全量分页和逐行验证，再原子替换镜像和快照。
- 失败时保留上一份有效资产镜像。

## 4. 修改模块

| 模块 | 责任 |
| --- | --- |
| `src/trading/p9-3-lineage.ts` | 统一 REAL/资产持久 lineage 和 predicate |
| `src/trading/p9-3-ledger-service.ts` | 账本 owner 边界、写前写后身份校验、人工 actor 约束 |
| `src/trading/p9-3-evidence-service.ts` | 钱包固定角色、能力快照、字段校验、失败队列、租约、保守游标、分页 |
| `src/trading/p9-3-fifo-service.ts` | 已售/未售 UNKNOWN 分离、胜率、确定性盈亏、新鲜度 |
| `src/trading/p9-3-audit-service.ts` | 审计事件和计算历史 owner 过滤 |
| `src/trading/p9-3-reconciliation-service.ts` | 对账查询和运行历史 owner 过滤 |
| `src/trading/p9-ai-analysis.ts` | AI 只读上下文 owner 过滤 |
| `src/assets/asset-sync-service.ts` | 原子资产镜像、规范哈希、generation/lease fencing |
| `src/web/p9-3-routes.ts` | 路由到显式 lineage，拒绝缺失/错误上下文 |
| `src/web/asset-routes.ts` | item-set 完整性、快照详情分页、跨角色 404 |
| `src/eve/character-sync.ts` | 余额异常保护、资产适配器委派、成功/错误状态分离 |
| `src/db/migrations.ts` | owner/chat/epoch schema、幂等重建、财务触发器和索引 |

## 5. 验证分层

- **代码验证**：已完成；见本目录 02-14。
- **隔离 SQLite/mock ESI 验证**：已完成；完整套件和专项日志见 15。
- **真实环境验证**：无。未使用真实 ESI 账户、真实钱包、生产数据库或生产部署。
- **未验证**：真实分页稳定性、真实 OAuth 失效、真实并发主机、真实费用补录、真实人工核实闭环。

## 6. 结论

五项原始反例均已改为拒绝或正确隔离。代码和隔离测试满足 P9.3.3.8 的修复完成条件，但不构成真实环境运营验证。
