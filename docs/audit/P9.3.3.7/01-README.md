# EVEAI P9.3.3.7 第四轮独立对抗性审计

## 结论

- 最终结论：`P9_3_3_7_AUDIT_FAILED`
- 业务状态：`REAL_ACCOUNTING_READY`
- 不得声明：`REAL_ACCOUNTING_OPERATIONALLY_VERIFIED`、`REAL_TRADING_READY`
- 下一阶段应建立独立修复阶段 `P9.3.3.8`，本阶段不修改业务代码。

## 审计范围

审计对象为 P9.3.3.6 修复后的当前工作区，覆盖：

- P9.3.3.5 历史缺陷 F-P9335-01..06、R-P9335-01..02 的独立回归复核。
- REAL 账本所有权、角色转移、解绑重绑与跨 owner 访问。
- 资产 ESI 获取、分页、标准化、镜像、快照、历史、去重与展示。
- 钱包成交同步、能力快照、角色固定、游标、失败重试和幂等。
- REAL/PAPER 隔离、ESI GET-only、CSRF 与审计账本。
- worker、lease、心跳、崩溃恢复和测试充分性。

## 基线

- 仓库：`/home/ubuntu/projects/eveai`
- 分支：`deploy/eve-ai-agent`
- HEAD：`9e8e8b32d0e065c6d8479140f94662087193279d`
- HEAD 不是完整基线；工作区存在大量既有未提交修改，详见 `02-baseline-and-worktree-integrity.md` 和 `logs/p9337-final-status.log`。
- 审计期间工作区继续被其他进程修改，最终 `--untracked-files=all` 快照为 342 路径；本阶段自身只新增 `tests/audit/p9-3.3.7/` 与 `docs/audit/P9.3.3.7/` 内容。
- 未修改业务代码、schema、migration，未 commit、push、部署或写生产数据库。

## 方法

1. 先静态追踪调用链和数据库结构。
2. 再设计独立反例，使用隔离 SQLite 和真实生产服务/路由代码。
3. 对关键结论要求可重复日志和数据库断言。
4. 最后执行历史回归、完整质量门禁和安全边界检查。
5. 不把“测试通过”本身当作产品正确性证明；专项测试中有 5 项通过是因为它们成功证明了当前漏洞行为。

## 发现统计

| 等级 | 数量 | 编号 |
|---|---:|---|
| P0 | 1 | F-P9337-01 |
| P1 | 2 | F-P9337-02、F-P9337-05 |
| P2 | 2 | F-P9337-03、F-P9337-04 |
| P3 | 0 | - |

F-P9337-01 满足“跨用户重大敏感数据泄露”和“跨 owner 财务数据被未授权修改”的 P0 条件。

## 历史缺陷复核

- P9.3.3.5 场景已独立重建：F-P9335-01..06、R-P9335-01..02 以及 5 次 in-flight 角色切换，共 13 项通过。
- P9.3.3.1..6 既有回归：33 个文件、171 项测试全部通过。
- 未复现 F-P9335-01..06、R-P9335-01..02 的既有修复回退。
- P9.3.3.6 的 owner-lineage 只覆盖资产相关表，未覆盖 REAL 账本和钱包游标，导致新的跨 owner 缺陷。

## 测试与门禁

- P9.3.3.7 专项：6 文件 / 34 测试通过；其中 3 文件 / 5 测试稳定复现当前漏洞。
- 历史回归：33 文件 / 171 测试通过。
- 完整 `npm test`：271 文件 / 2339 测试通过。
- `npm run typecheck`、`web:check`、`lint`、`build`、`audit:public`、`git diff --check`、`git diff --cached --check` 均通过。
- Build 存在 Vite chunk size warning，未隐藏。
- 初次并行 `web:check` 受工作区并发修改影响短暂失败，最终重跑和 build 中的 web TS 检查均通过；详见 15。

## 未覆盖与限制

- 未使用真实 EVE 账号、真实 token、真实生产钱包或生产数据库。
- 未执行生产迁移、多实例部署、真实限流/网络故障注入。
- 真实账本运营闭环未验证。
- 证据等级：代码验证 + 隔离 SQLite 测试数据验证；无真实环境验证。

## 交付文件

- `01-README.md`
- `02-baseline-and-worktree-integrity.md`
- `03-p9335-historical-findings-verification.md`
- `04-owner-lineage-and-idor-audit.md`
- `05-asset-write-path-inventory.md`
- `06-mirror-snapshot-consistency-audit.md`
- `07-canonical-hash-and-deduplication-audit.md`
- `08-esi-pagination-integrity-audit.md`
- `09-numeric-safety-audit.md`
- `10-wallet-journal-integrity-audit.md`
- `11-worker-lease-and-recovery-audit.md`
- `12-real-paper-isolation-audit.md`
- `13-esi-get-only-and-network-boundary-audit.md`
- `14-auth-csrf-and-audit-ledger-audit.md`
- `15-test-evidence-and-quality-gates.md`
- `16-findings-and-remediation-priority.md`
- `17-final-audit-verdict.md`