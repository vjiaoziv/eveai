# EVEAI P9.3.3.9 第五轮独立对抗性审计

## 最终状态

```text
P9_3_3_9_AUDIT_FAILED
```

业务状态保持：

```text
REAL_ACCOUNTING_READY
```

不得声明：

```text
REAL_ACCOUNTING_OPERATIONALLY_VERIFIED
REAL_TRADING_READY
```

## 审计范围

本轮独立复核 P9.3.3.8 的修复及新机制，覆盖：

- P9.3.3.7 五项历史缺陷的独立重建。
- REAL 账本、证据、审计历史、冲正与更正的 owner/binding 隔离。
- 钱包能力快照、角色固定、scope、分页、严格字段校验、失败队列与游标。
- FIFO UNKNOWN 成本、已实现盈亏、胜率、重算与新鲜度。
- 钱包余额、钱包 journal 与资产镜像的数据完整性。
- 资产 lane 隔离、canonical hash、快照分页和 generation fencing。
- migration 回滚、SIGKILL 恢复、多进程并发。
- REAL/PAPER 隔离、AI 写账本边界和 ESI GET-only。

## 基线

- 仓库：`/home/ubuntu/projects/eveai`
- 分支：`deploy/eve-ai-agent`
- HEAD：`9e8e8b32d0e065c6d8479140f94662087193279d`
- 审计开始时 `git status --short --untracked-files=all`：386 项。
- 报告生成前工作区快照：402 项。
- 报告生成后工作区快照：423 项；status SHA-256：`e110845cee826345a30a88528c47026223c3cc940d65ee2b5512883ed93d1f8c`。
- 工作区存在大量既有未提交修改，审计未 reset、clean、checkout、restore、stash、commit、push 或部署。
- 本阶段只新增 `tests/audit/p9-3.3.9/`、`docs/audit/P9.3.3.9/` 下的审计文件。

## 新发现

| 等级 | 编号 | 结论 |
|---|---|---|
| P0 | - | 无 |
| P1 | F-P9339-01 | 无损 scope 刷新改变 asset binding digest 后，第二次资产同步因 latest-snapshot 唯一约束失败；旧快照和 mirror 在新 digest 下不可见。 |
| P2 | F-P9339-02 | `P93AuditService.events(..., recordId, ...)` 的 SQL 占位符顺序与参数顺序不一致，原 owner 的 record-scoped 审计历史被错误返回为空。 |
| P3 | - | 无 |

统计：P0 `0`，P1 `1`，P2 `1`，P3 `0`。

## 历史缺陷复核

P9.3.3.7 五项历史缺陷均已通过本轮独立反例重新构造，未复现：

- F-P9337-01：REAL 账本跨 owner 读取/操作被拒绝。
- F-P9337-02：同一角色不同 chat lane 的资产 mirror 保持隔离。
- F-P9337-03：不同 item set 即使聚合计数相同也不会误判一致。
- F-P9337-04：snapshot detail 分页不再静默截断。
- F-P9337-05：角色转移后钱包游标和失败状态不跨 owner 继承。

历史回归结果：

- P9.3.3.7 专项：6 files / 35 tests 通过。
- P9.3.3.8 专项：8 files / 25 tests 通过。
- P9.3.3.1–P9.3.3.6 历史：29 files / 139 tests 通过。

## 测试结果

本轮独立专项：

- 13 files / 48 tests。
- 46 passed，2 failed，0 skipped，exit code `1`。
- 两项失败分别稳定复现 F-P9339-01 和 F-P9339-02，未删除、跳过或弱化断言。

完整项目测试：

- 296 files / 2441 tests。
- 2439 passed，2 failed，0 skipped，exit code `1`。
- 失败项仍是上述两个产品缺陷。

质量门禁：

- `npm run typecheck`：PASS。
- `npm run web:check`：PASS。
- `npm test`：FAIL（2 项真实产品缺陷）。
- `npm run lint`：PASS。
- `npm run build`：PASS，但保留 Vite chunk-size warning。
- `npm run audit:public`：PASS。
- `git diff --check`、`git diff --cached --check`：PASS。

## 证据等级

- **已通过代码验证**：已完成关键路由、服务、SQL、事务、migration、ESI 调用链与前端新鲜度消费路径的静态追踪。
- **已通过隔离测试数据验证**：已完成专项、历史、完整测试、多进程和 SIGKILL 场景；全部使用隔离 SQLite/mock ESI。
- **已通过真实环境验证**：无。
- **尚未验证**：真实 EVE OAuth/SSO、真实角色切换、真实钱包数据、真实 ESI 限流与分页、生产数据库迁移/恢复、真实人工核实到 FIFO 的运营闭环、生产部署与高负载。

## 最终判断

本轮发现 1 个 P1 和 1 个 P2，未满足 `P9_3_3_9_AUDIT_PASSED` 的准入条件，因此判定：

```text
P9_3_3_9_AUDIT_FAILED
```

必须进入 `P9.3.3.10 — Targeted Remediation`。不得进入 P9.3.4/P9.4，不得部署，不得宣称真实会计核算已在生产运营中验证。

## 报告索引

- [02-baseline-and-worktree-integrity.md](02-baseline-and-worktree-integrity.md)
- [03-p9337-historical-findings-verification.md](03-p9337-historical-findings-verification.md)
- [04-real-ledger-owner-isolation.md](04-real-ledger-owner-isolation.md)
- [05-evidence-and-audit-history-authorization.md](05-evidence-and-audit-history-authorization.md)
- [06-reversal-and-correction-race-audit.md](06-reversal-and-correction-race-audit.md)
- [07-owner-lane-asset-isolation.md](07-owner-lane-asset-isolation.md)
- [08-wallet-cursor-and-capability-snapshot.md](08-wallet-cursor-and-capability-snapshot.md)
- [09-wallet-failure-queue-recovery.md](09-wallet-failure-queue-recovery.md)
- [10-wallet-journal-validation.md](10-wallet-journal-validation.md)
- [11-wallet-balance-last-known-good.md](11-wallet-balance-last-known-good.md)
- [12-fifo-unknown-cost-and-pnl-audit.md](12-fifo-unknown-cost-and-pnl-audit.md)
- [13-asset-mirror-atomic-replacement.md](13-asset-mirror-atomic-replacement.md)
- [14-item-set-integrity-and-canonical-hash.md](14-item-set-integrity-and-canonical-hash.md)
- [15-snapshot-pagination-and-consistency.md](15-snapshot-pagination-and-consistency.md)
- [16-migration-atomicity-and-recovery.md](16-migration-atomicity-and-recovery.md)
- [17-real-paper-and-esi-get-only-regression.md](17-real-paper-and-esi-get-only-regression.md)
- [18-concurrency-and-multiprocess-evidence.md](18-concurrency-and-multiprocess-evidence.md)
- [19-test-evidence-and-quality-gates.md](19-test-evidence-and-quality-gates.md)
- [20-findings-and-remediation-priority.md](20-findings-and-remediation-priority.md)
- [21-final-audit-verdict.md](21-final-audit-verdict.md)



