# P9.3 财务闭环验证报告

## 1. 结论

**最终状态：`REAL_ACCOUNTING_READY`。**

P9.3 的账本状态机、证据门禁、FIFO、已实现/未实现盈亏、资产对账和冲正计算：**已通过隔离测试数据验证**。生产数据库已完成零样本迁移和只读完整性核验，但没有任何真实交易事实，因此真实业务闭环尚无运营验证结论。

## 2. 生产数据库只读事实

**已通过真实环境验证**

- `quick_check = ok`
- 外键违规 = 0
- `real_trade_records = 0`
- `real_trade_events = 0`
- `real_trade_evidence = 0`
- `real_trade_evidence_links = 0`
- `real_fifo_lots = 0`
- `real_fifo_consumptions = 0`
- `real_asset_snapshots = 3`
- `real_asset_snapshot_items = 1501`
- `real_asset_valuations = 1`
- `real_reconciliation_runs = 1`
- `real_reconciliation_items = 406`
- `real_reconciliation_cases = 0`
- `paper_trading_accounts = 1`
- `paper_trading_orders = 0`
- `paper_fills = 0`
- `character_wallet_journal = 0`
- `character_orders = 0`
- `trade_drafts = 1`（历史 `audit_revoked` 草案，不是真实成交）

数据库存在 21 个 REAL 财务触发器，覆盖交易事实不可删除/不可覆盖、草稿不可核实、VERIFIED 需匹配证据、冲突证据阻断、费用仅限 DRAFT、事件只追加、已核实证据不可删除、ESI 证据单交易支持等约束。`idx_real_fifo_consumptions_unique_consumption` 唯一索引防止同一卖出重复消耗同一批次。

## 3. 十二项业务验证矩阵

| 验证项 | 结论 | 证据与限制 |
|---|---|---|
| 1. 真实资产同步 | **已通过真实环境验证** | 最新 `ASSETSNAP-1793722807909-682d8d55`，COMPLETED，513 items / 378 types / 18 locations / 176856 quantity；资产页可读取。 |
| 2. 钱包日志同步 | **尚未验证** | 代码和 GET-only 网关已通过代码/隔离测试；生产无钱包日志或同步游标样本，未在生产执行写同步。 |
| 3. 市场订单数据关联 | **尚未验证** | `market_orders` 有 1,561,888 条市场公共订单，`character_orders = 0`；没有真实订单→成交→交易证据样本。 |
| 4. 人工登记真实交易 | **尚未验证** | 本轮禁止向 REAL 生产账本写入测试数据；隔离测试已验证登记/校验/状态机路径。 |
| 5. 交易证据关联及核实 | **尚未验证** | 生产 `real_trade_evidence = 0`；隔离测试验证了人工附件、钱包证据、冲突证据和草稿门禁。 |
| 6. FIFO 成本批次生成 | **尚未验证** | 生产 `real_fifo_lots = 0`；隔离测试验证批次生成、成本资本化、UNKNOWN 成本和精度边界。 |
| 7. 部分卖出与 FIFO 成本消耗 | **尚未验证** | 生产 `real_fifo_consumptions = 0`；隔离测试验证部分消耗、剩余成本和重复消耗阻断。 |
| 8. 已实现盈亏重算 | **尚未验证** | 生产无已核实交易；隔离测试验证重算、费用、数量/精度和历史版本。 |
| 9. 未实现盈亏计算 | **尚未验证** | 代码和隔离测试验证明确库存估值口径；当前 REAL 库存为空，只能显示空态/N/A，不能形成真实未实现盈亏样本。 |
| 10. 资产账本对账 | **尚未验证** | 最新对账绑定旧 483 行快照，406 个聚合键全部为 `UNKNOWN_SOURCE`；该结果是空账本下的历史基线，不代表 406 笔交易。真实交易驱动的对账仍需样本。 |
| 11. 重复记录检测 | **已通过隔离测试数据验证** | 测试覆盖重复来源、同一 ESI 证据跨交易、FIFO 重复消耗；生产对账摘要 `duplicateSourceReferences=0`。 |
| 12. 交易冲正及历史重算 | **尚未验证** | 生产无真实交易；隔离测试验证冲正不删除原事实、追加事件和幂等历史重算。 |

## 4. 财务边界逐项核对

**已通过隔离测试数据验证**

- 用户申报 ≠ 已核实交易：DRAFT/PENDING 不进入正式已实现盈亏。
- 钱包日志关联 ≠ 交易事实充分核实：钱包证据必须状态 VERIFIED、来源为 `ESI_WALLET_TRANSACTIONS` 且 `source_ref` 完全匹配。
- 订单记录 ≠ 成交记录：`ESI_MARKET_ORDER` 不能单独支持 VERIFIED。
- 资产增加 ≠ 买入；资产减少 ≠ 卖出：资产变化不会自动生成已核实交易。
- UNKNOWN 成本不能强制设置为零：未知成本保持未知并阻止错误利润口径。
- 未核实记录不进入正式已实现盈亏。
- 未实现盈亏使用明确的库存估值口径：市场参考、买单深度清算、卖单重置成本和历史成本分别展示，禁止相加成虚假总资产。
- FIFO 批次不得重复消耗：唯一索引 + 服务层检查。
- 冲正不得无痕删除原始交易：原始事实保留，追加审计事件和新计算版本。
- Paper Trading 不进入 REAL 财务统计：独立表、独立角色、独立路由和测试。

## 5. 资产估值新鲜度缺陷

**已通过真实环境验证**

生产最新快照为 513 行：

- `ASSETSNAP-1793722807909-682d8d55`
- COMPLETED
- `2026-11-03T16:20:07.909Z`

最近估值为：

- `ASSETVAL-1793694160630-ddaddae0`
- 绑定旧快照 `ASSETSNAP-1793694005368-cec3e526`
- 336 valued / 43 unknown
- 相对当前快照状态为 `STALE`

修复后 `/api/web/assets/overview` 返回 `valuationFreshness`，资产页明确提示旧估值快照，不再把旧估值当作当前库存总值。当前生产估值本身仍是历史结果，需要未来在人工确认后重新估值；本轮没有触发生产写操作。

## 6. 最终财务状态

**`REAL_ACCOUNTING_READY`**

满足代码、迁移、触发器、隔离测试、零样本派生计算和生产只读完整性条件；不满足 `REAL_ACCOUNTING_OPERATIONALLY_VERIFIED`，因为缺少真实交易、证据、钱包/成交关联、FIFO 消耗、盈亏和冲正样本。
