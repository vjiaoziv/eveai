# 未解决风险与未验证范围

## 1. 无已知阻断项

本轮没有发现仍可复现的 F-P9333-01、F-P9333-02、F-P9333-03、F-P9333-04 路径，也没有发现新增 P0/P1/P2 缺陷。

## 2. 非阻断风险

### R1：真实 ESI 和真实账户未验证

本轮所有 ESI 响应均为测试替身。真实响应规模、字段异常、token refresh、SSO 解绑和 owner hash 变化需要在授权的真实账号上验证。不得把本轮结果表述为 `REAL_ACCOUNTING_OPERATIONALLY_VERIFIED`。

### R2：生产数据库迁移未执行

迁移已在旧 schema 的临时 SQLite 上验证，但没有在生产数据库执行。部署前需要备份、dry-run/副本演练、数据量评估和回滚方案。

### R3：stale recovery 依赖配置窗口

进程崩溃后，当前 lease 要等 `assetSync.staleJobMinutes`（默认 30 分钟）才会被下一次申请回收。该设计防止活跃任务被过早抢占，但崩溃后的自动恢复不是即时的；本轮未增加 lease renewal 或外部 worker liveness。

### R4：SQLite 部署边界

数据库级互斥基于同一 SQLite 数据库文件和 WAL。跨主机网络文件系统、多个独立 SQLite 副本或外部数据库不在此证明范围。

### R5：SSE 负载敏感性

Perimeter Radar 历史上出现一次全量负载下 SSE frame 可见性超时。本轮隔离连续 3 次与全量测试均通过，未改写测试或产品逻辑；仍需 CI 长期观察和独立审计确认。

### R6：前端 chunk 体积警告

生产构建成功，但主 JS chunk 超过 Vite 500 kB 建议阈值。它不影响本阶段逻辑正确性，属于后续性能优化项，不在本轮扩大范围。

## 3. 尚未验证

- 真实 EVE 钱包和资产响应；
- 真实角色解绑/重绑和 SSO owner transfer；
- 生产 SQLite 数据迁移；
- 生产并发负载、进程 kill、磁盘满和 I/O error；
- 真实 REAL/PAPER 运营闭环；
- 生产前端 bundle 性能与缓存策略。

## 4. 建议后续

1. 由独立审计者复核 F-P9333-01 至 F-P9333-04 的事务时序和测试屏障；
2. 在临时生产副本上演练 migration 和 stale recovery；
3. 在获授权的真实测试账号执行只读 ESI 验证，并保持人工核实边界；
4. 在 CI 中持续观察 SSE 和双进程测试稳定性；
5. 进入 P9.3.4 前等待本轮独立审计结论，不自动推进。
