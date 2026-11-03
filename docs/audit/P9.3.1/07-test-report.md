# 测试报告

## 1. 基线复现

**已通过代码验证**

审计开始时：

- `tests/unit/p9-3-real-accounting.test.ts`：7/7 pass。
- `npm run typecheck`：pass。
- `tests/integration/perimeter-radar.test.ts`：失败，表现为 async poller 清理/固定时间断言不稳定。

## 2. perimeter-radar 调查

**已通过代码验证；已通过隔离测试数据验证**

不是单纯改断言或重跑：

1. 发现真实 SSE 清理缺口：`SseStream.onClose` 在 close 已发生后注册时不会执行，会泄漏 poller/timer/audience/advisor ref。
2. 修复 `onClose` 对已关闭 stream 立即执行 handler。
3. 测试层面的不稳定因素包括：
   - 用固定 fake-time 间隔断言异步 advisory/intel 已达到；
   - 只等 `intel` 而没有等待 `ready`，导致 tab 可能尚未加入 audience；
   - 失败后未关闭所有 SSE client，导致 afterEach 级联超时；
   - fake timers 的 5 秒窗口在并行负载下不足。
4. 测试改用 `advanceUntil` 等待可观察状态、READY 门禁和统一 client teardown。
5. `perimeter-radar.test.ts` 全量连续 3 次通过，并在最终全量 `npm run check` 中通过。

## 3. 专项和回归结果

**已通过隔离测试数据验证**

- P9.3 原始专项：7/7 pass。
- P9.3.1 hardening：14/14 pass。
- P9.3 + hardening 总计：21/21 pass。
- P9.2 资产回归：28/28 pass（asset inventory/valuation/history/sync/routes/opportunity match）。
- P9 safety/AI：4/4 pass。
- perimeter-radar：5/5 pass，连续 3 次。
- P9.3 相关合计：30/30 pass（P9.3 21 + P9 safety 4 + perimeter 5）。

## 4. 全量质量门禁

**已通过隔离测试数据验证**

最终执行：

```text
npm run check
```

结果：

- TypeScript typecheck：通过
- web typecheck：通过
- Vitest：225/225 test files pass，2081/2081 tests pass
- ESLint：0 errors，0 warnings
- 完整命令退出码：0

完整日志：

- `docs/audit/P9.3.1/_work/final-check.log`

## 5. 构建

**已通过代码验证**

```text
npm run build
```

- 后端 TypeScript 编译通过。
- web typecheck 通过。
- Vite production build 通过。
- 仅有 Vite 既有 bundle >500 kB 提示，不是失败。

## 6. 真实数据库验证

**已通过真实环境验证**

- 迁移前在线备份：`data/backups/eve-agent.db.bak_20261103_p931_pre`
- 备份大小：1,137,184,768 bytes
- 备份 integrity_check：ok
- `npm run db:migrate`：Done
- 生产库 `P93AuditService.integrityCheck`：ok
- 16 个财务 trigger 全部存在
- 4 个 FIFO index 全部存在
- 迁移后 `real_trade_records/events/evidence` 均为 0

## 7. 未覆盖

**尚未验证**

- 真实交易样本的端到端测试。
- 真实角色 ESI wallet transaction 导入。
- 真实人工证据核实、冲正和更正。
- 真实交易后的 FIFO/PNL/对账结果。

## 8. 结论

- 自动化门禁：全绿。
- 隔离财务流程：通过。
- 真实零状态数据库/迁移/集成：通过。
- 真实交易闭环：尚未验证。