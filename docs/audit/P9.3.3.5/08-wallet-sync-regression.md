# 钱包同步回归与历史保护

## 1. 专项范围

本轮复跑了钱包、证据、FIFO 和 freshness 相关 12 个测试文件，共 56 项，全部通过：

- 钱包路由固定角色、scope、解绑和分页失败。
- ESI 钱包交易严格类型。
- 能力快照重建与 wallet scope 检查。
- 低 transactionId 失败不能被高 ID 越过。
- 失败队列重试和幂等导入。
- 人工核实事实不被覆盖。
- 跨连接、跨进程钱包 lease。
- 旧 lease owner fencing。
- 钱包异常余额保护。
- FIFO 已实现盈亏与未售出 UNKNOWN 分离。
- FIFO freshness CURRENT/STALE。
- evidence/link 幂等。

## 2. 结论

P9.3.3.4 的资产协调器修改没有造成已覆盖钱包机制回归。

但发现 F-P9335-06：

- `src/eve/character-sync.ts:237-278` 对 wallet journal 使用 `asArray()`；
- 非数组 200 响应被转换为空数组；
- `refreshDataset()` 在 `src/eve/character-sync.ts:837-850` 标记 `status='ok'`、`rows_synced=0`；
- 实测原私有 journal 行保留，但 malformed ESI 输入被误报为成功同步。

该问题不删除数据，但会错误清除/刷新同步状态和错误可见性，属于 P2 数据完整性/可观测性缺陷。

## 3. 资产与钱包 lease 关系

资产 lease 与钱包 lease 是独立表：

- `real_asset_sync_leases`
- `real_esi_transaction_sync_leases`

专项测试未发现资产修改错误释放钱包 lease、复用 generation 或覆盖钱包证据。生产跨进程长负载未验证。

## 4. 证据等级

- 代码与隔离测试：已验证。
- 真实 ESI 钱包、真实 OAuth 撤销和生产 concurrency：未验证。
