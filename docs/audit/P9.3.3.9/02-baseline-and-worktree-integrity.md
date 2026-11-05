# 02 基线与工作区完整性

## 1. 启动基线

审计启动时重新获取并记录：

- 仓库：`/home/ubuntu/projects/eveai`
- 分支：`deploy/eve-ai-agent`
- HEAD：`9e8e8b32d0e065c6d8479140f94662087193279d`
- `git status --short --untracked-files=all`：386 项
- status 快照 SHA-256：`41f3dd11173661d6de8a4581f0de6cb62a8f6a99d7d66f14b76851d50baf4df6`
- unstaged binary diff SHA-256：`2e3d3545bc96ec96dfa8e453a88344f7c069004c0ae1f85600c72e75d098be78`
- staged binary diff SHA-256：`7f83e7a8b5fcd7378bd5f9038be0a9aca89730d4982c62811d4d16bbcaddc6d5f`

原始证据：`logs/00-baseline-worktree.log`。

工作区包含大量既有修改和未跟踪文件。本阶段据此采用只读业务代码策略：不在既有文件上进行业务修复，不清理、不重置、不覆盖用户或其他会话的改动。

## 2. 审计自身新增内容

报告生成前新增：

- 13 个 `.test.ts` 测试文件。
- 3 个 child/helper 文件：`ledger-reversal-child.ts`、`migration-kill-child.ts`、`wallet-recovery-child.ts`。
- `docs/audit/P9.3.3.9/logs/` 下的运行日志。

实测工作区由 386 项变为 402 项；差异仅为本阶段审计测试、helper 和日志。记录见：

- `logs/30-final-status.log`
- `logs/31-status-delta.log`

审计期间 staged 与 unstaged 业务 diff 哈希保持不变，说明本阶段没有改写已跟踪业务代码、schema 或既有测试。

## 3. 报告生成后的复核

所有 21 份报告生成后重新执行工作区快照和 diff 哈希：

- 最终 `git status --short --untracked-files=all`：423 项。
- 最终 status 快照 SHA-256：`e110845cee826345a30a88528c47026223c3cc940d65ee2b5512883ed93d1f8c`。
- unstaged binary diff SHA-256：`2e3d3545bc96ec96dfa8e453a88344f7c069004c0ae1f85600c72e75d098be78`，与基线相同。
- staged binary diff SHA-256：`7f83e7a8b5fcd7378bd5f9038be0a9aca89730d4982c62811d4d16bbcaddc6d5f`，与基线相同。
- 21 份必需报告全部存在且非空。
- 13 个审计测试文件、3 个 helper 文件均保留。

基线 386 项到最终 423 项的差异为：

- 13 个 P9.3.3.9 测试文件。
- 3 个 child/helper 文件。
- 21 份 P9.3.3.9 报告。

审计日志目录按仓库现有规则不进入上述 status 计数。完整记录见 `logs/32-report-finalization.log`。staged/unstaged 业务 diff 哈希前后一致，说明本阶段没有改写已跟踪业务代码、schema 或既有测试。

## 4. 禁止操作核对

本阶段未执行：

- `git reset`
- `git clean`
- `git checkout`
- `git restore`
- `git stash`
- rebase 或历史重写
- commit
- push
- 生产部署
- 生产数据库写入
- 真实 EVE 交易

## 5. 证据等级

- 代码验证：已完成基线与审计新增范围确认。
- 隔离测试数据验证：不适用于本文件。
- 真实环境验证：无。
- 尚未验证：其他 Codex 会话或自动化任务未来是否继续修改工作区；本结论只覆盖上述已记录快照。

