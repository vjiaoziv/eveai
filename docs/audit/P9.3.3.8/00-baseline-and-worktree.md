# P9.3.3.8 基线和工作区状态

- 记录时间：2026-11-05（Asia/Shanghai；UTC 基线日志为 2026-11-05T03:25:10Z）
- 权威仓库：`/home/ubuntu/projects/eveai`
- 分支：`deploy/eve-ai-agent`
- HEAD：`9e8e8b32d0e065c6d8479140f94662087193279d`
- 工作区路径数：342；staged paths：99；unstaged tracked：94；untracked：149。
- 基线日志：`logs/00-baseline-head.log`、`00-baseline-status.log`、`00-baseline-unstaged-stat.log`、`00-baseline-unstaged-files.log`、`00-baseline-staged-stat.log`、`00-baseline-untracked-files.log`。
- 未执行 reset、clean、checkout、restore、stash、rebase、cherry-pick、commit 或 push。

## 修复前反例复现

命令：`npx vitest run tests/audit/p9-3.3.7 --reporter=verbose`

结果：6 files passed，34 tests passed；这些测试中的 5 项断言的是脆弱行为，仅用于证明缺陷仍可复现。日志：`logs/00-baseline-p9337-reproduction.log`。

| 缺陷 | 原始反例 | 是否复现 | 证据 | 修复模块 |
|---|---|---|---|---|
| F-P9337-01 | 新 owner 读取并冲正旧 owner 的 REAL 账本 | 是 | `tests/audit/p9-3.3.7/owner-ledger-isolation-audit.test.ts`；基线日志 | `src/web/p9-3-routes.ts`、`src/trading/p9-3-*.ts`、`src/db/migrations.ts` |
| F-P9337-02 | 同一角色 B lane 删除 A lane mirror | 是 | `tests/audit/p9-3.3.7/asset-consistency-audit.test.ts`；基线日志 | `src/assets/asset-sync-service.ts`、`src/db/migrations.ts` |
| F-P9337-05 | 所有权转移继承钱包游标并跳过较低 transactionId | 是 | `tests/audit/p9-3.3.7/wallet-owner-cursor-audit.test.ts`；基线日志 | `src/trading/p9-3-evidence-service.ts`、`src/db/migrations.ts` |
| F-P9337-03 | 不同 item set 因聚合计数相同标记 COMPLETE | 是 | `tests/audit/p9-3.3.7/asset-consistency-audit.test.ts`；基线日志 | `src/web/asset-routes.ts` |
| F-P9337-04 | snapshot detail 超过 5000 条静默截断 | 是 | `tests/audit/p9-3.3.7/asset-consistency-audit.test.ts`；基线日志 | `src/web/asset-routes.ts`、前端 API/展示 |

## 基线结论

基线代码可稳定复现五项缺陷。工作区已有大量未提交修改，全部保留；本阶段只对上述缺陷相关路径做增量修改，并在最终报告中单独列出本阶段修改。当前未实现任何修复。

## 交付时工作区状态（2026-11-05）

- 以下数据在证据复核和并发 5 轮测试完成后重新采集；它是交付时快照，不替换上方历史基线。
- `git status --short` 记录数：262。
- staged paths：99。
- unstaged tracked paths：102。
- untracked paths：183（其中 P9.3.3.8 的 19 个 Markdown 报告文件为未跟踪交付物）。
- 分支仍为 `deploy/eve-ai-agent`，HEAD 仍为 `9e8e8b32d0e065c6d8479140f94662087193279d`。
- 历史基线中的 342 个路径、staged 99、unstaged tracked 94、untracked 149 保持原样记录，未回写为当前数字。
- 交付前 `git diff --check` 与 `git diff --cached --check` 均返回 exit 0。
- 本轮没有执行 reset、clean、checkout、restore、stash、rebase、cherry-pick、commit、push 或部署。
- P9.3.3.8 的报告与日志仍为未提交审计交付物，不能据此推断这些文件已进入 Git 历史。

### 交付时证据目录

- 修复前反例：`logs/00-baseline-p9337-reproduction.log`。
- 完整测试：`logs/16-npm-test-after-fixture-fix.log`。
- 最终专项测试：`logs/18-specialized-final.log`。
- 并发 5 轮：`logs/19-concurrency-repeat-5x.log`。
- 质量门禁：`logs/17-*-final.log`。

### 状态声明

- 可以声明：`P9_3_3_8_FIXES_COMPLETE`。
- 可以维持：`P9_3_3_CODE_HARDENED`、`REAL_ACCOUNTING_READY`。
- 不可声明：`REAL_ACCOUNTING_OPERATIONALLY_VERIFIED`、`REAL_TRADING_READY`。
- P9.3.3.9 独立审计仍待执行。
