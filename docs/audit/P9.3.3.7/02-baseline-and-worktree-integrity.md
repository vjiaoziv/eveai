# 02 基线、工作区完整性与证据等级

## 代码基线

- 仓库：`/home/ubuntu/projects/eveai`
- 分支：`deploy/eve-ai-agent`
- HEAD：`9e8e8b32d0e065c6d8479140f94662087193279d`
- 未执行 reset、clean、checkout、restore、commit、push、部署或生产数据库操作。

## 工作区快照

### 审计开始观察

观察时间：2026-11-05 02:20 UTC。完整列表见 `logs/baseline-status.log`。

- `git status --porcelain=v1 --untracked-files=all`：302 个路径。
- 已暂存路径：99。
- 未跟踪路径：128。
- 其他跟踪修改：75。
- 工作区包含 P8/P9 历史文档迁移、代码修改和审计材料，数量不能由 HEAD 代表。

### 审计结束观察

最终快照见 `logs/p9337-final-status.log`。

- `git status --porcelain=v1 --untracked-files=all`：342 个路径。
- 已暂存路径：99。
- 未暂存跟踪修改：94。
- 未跟踪路径：149。
- 审计期间其他进程继续修改工作区；本阶段没有清理、覆盖或重置这些修改。
- 本阶段自身只新增 `tests/audit/p9-3.3.7/` 和 `docs/audit/P9.3.3.7/` 内容。

> 审计结论以“当前最终文件内容 + 隔离运行证据”为准，不把 HEAD 与当前工作区混同。

## 差异检查

- `git diff --check`：PASS，日志 `logs/p9337-git-diff-check.log`。
- `git diff --cached --check`：PASS，日志 `logs/p9337-git-diff-cached-check.log`。
- 两项检查只覆盖 tracked/staged 内容；新增未跟踪审计文件不在其范围内。

## 历史材料清单

- P9.3.3.6 报告：15 个文件，清单见 `logs/artifact-inventory.log`。
- P9.3.3.1..6 历史测试：33 个测试文件（另列 2 个 helper）。
- P9.3.3.7 独立专项测试：6 个文件、34 个测试。

## 证据等级

| 等级 | 含义 | 本次使用 |
|---|---|---|
| A | 真实生产代码、真实生产数据/多实例、可重复反例 | 未达到 |
| B | 真实生产代码、独立 SQLite、单进程并发 | 主要证据 |
| C | 集成测试或受控桩 | 部分 ESI 测试 |
| D | 静态阅读、纯 mock | 仅作补充，不作关键定论 |

本次没有真实环境验证。不得将隔离测试写成生产验证。

## 基线限制

1. HEAD 无法表示未提交的 P9.3.3.6 及后续工作区修改。
2. 工作区在审计过程中存在并发变化，最终快照与初始快照不同。
3. 真实 EVE 服务、真实权限 token、生产 SQLite/锁竞争和生产迁移均未覆盖。