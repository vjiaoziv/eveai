# 15 测试证据与质量门禁

## P9.3.3.7 专项对抗测试

| 测试文件 | 测试数 | 结果 | 主要用途 |
|---|---:|---|---|
| `owner-ledger-isolation-audit.test.ts` | 1 | PASS（漏洞复现） | F-P9337-01 REAL owner 跨域读取/冲正 |
| `asset-consistency-audit.test.ts` | 3 | PASS（漏洞复现） | F-P9337-02/03/04 |
| `wallet-owner-cursor-audit.test.ts` | 1 | PASS（漏洞复现） | F-P9337-05 游标继承 |
| `historical-regression-audit.test.ts` | 13 | PASS | F-P9335-01..06、R-P9335-01..02、5 次 in-flight 角色切换 |
| `wallet-cursor-integrity-audit.test.ts` | 13 | PASS | 严格字段校验、scope、游标、失败重试、幂等、分页、身份变化 |
| `network-and-safety-boundary-audit.test.ts` | 3 | PASS | ESI GET-only、REAL/PAPER、AI 工具面 |
| **合计** | **6 文件 / 34 测试** | **PASS** | `logs/p9337-expanded-audit.log` |

> 这里的 PASS 表示测试稳定运行并证明其断言。前 3 个漏洞复现文件的 PASS 表示漏洞被成功触发，不表示产品安全通过。

## 历史回归

- 范围：`tests/unit/p9-3.3-*.test.ts` 及 `p9-3.3.1-*` 至 `p9-3.3.6-*`。
- 结果：33 个文件、171 项测试全部通过。
- 日志：`logs/p9337-historical-regression.log`。

## 完整质量门禁

最终快照执行结果：

| 命令 | 结果 | 证据 |
|---|---|---|
| `npm run typecheck` | PASS，exit 0 | `logs/p9337-typecheck-final.log` |
| `npm run web:check` | PASS，exit 0 | `logs/p9337-web-check-final.log` |
| `npm test` | PASS，271 文件 / 2339 测试 | `logs/p9337-npm-test.log` |
| `npm run lint` | PASS，exit 0，零 warning | `logs/p9337-lint-final.log` |
| `npm run build` | PASS，exit 0 | `logs/p9337-build-final.log` |
| `npm run audit:public` | PASS | `logs/p9337-audit-public-final.log` |
| `git diff --check` | PASS | `logs/p9337-git-diff-check.log` |
| `git diff --cached --check` | PASS | `logs/p9337-git-diff-cached-check.log` |

## 并发工作区说明

- 工作区在审计期间被其他进程继续修改：初始 `git status --porcelain=v1 --untracked-files=all` 为 302 路径，最终为 342 路径。
- 初次并行执行 `web:check` 时曾短暂报 `web/src/api.ts: Cannot find name 'readStoredLocale'`；对应文件随后由工作区修改恢复一致，立即重跑通过。最终 `build` 也重新执行了 web TypeScript 检查和 Vite 构建。
- 本次审计没有修改业务代码、schema、migration 或既有测试；只新增 `tests/audit/p9-3.3.7/`、`docs/audit/P9.3.3.7/` 内容。
- 上述门禁结果对应当前最终工作区文件，不等同于 HEAD 的干净版本。

## Build warning

`npm run build` 仍报告 Vite chunk size warning：`web/dist/assets/index-DVLB3qFT.js` 约 726.32 kB（gzip 约 207.58 kB），超过 500 kB 提示阈值。未通过修改阈值或关闭规则隐藏该提示。

## 证据等级

- 代码验证：已完成。
- 隔离 SQLite/test-data 验证：已完成。
- 真实环境验证：**没有**。
- 尚未验证：真实 ESI、真实 token、生产 SQLite/迁移、真实多实例、真实钱包和人工核实后的 FIFO/盈亏运营闭环。

## 结论

专项 34 项、历史回归 171 项和最终完整门禁全部通过。但门禁通过不能推翻已由独立反例证明的 F-P9337-01、F-P9337-02、F-P9337-05，也不能替代真实环境验证。