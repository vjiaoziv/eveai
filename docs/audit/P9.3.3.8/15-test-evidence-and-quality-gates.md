# 15 测试证据和质量门禁

## 1. 完整套件

### 初次完整运行

日志：`logs/15-npm-test.log`

结果：

- 282 test files：280 passed，2 failed；
- 2383 tests：2380 passed，3 failed；
- 失败原因是三个旧测试 fixture 没有建立 owner 绑定，却通过显式 lineage 读取/对账；生产查询的 owner 过滤正确，问题在测试准备数据。

### 修复 fixture 后完整运行

日志：`logs/16-npm-test-after-fixture-fix.log`

结果：

- 282/282 test files passed；
- 2383/2383 tests passed；
- exit code 0；
- 约 188.15s。

没有通过放宽生产授权查询来修复测试；只在测试中补充了有 owner 的 users/session/account/link/fixture。

## 2. 专项测试

日志：`logs/18-specialized-final.log`

结果：10 files / 64 tests passed。

覆盖：

- `P93EsiEvidenceService` 字段、能力快照、角色固定、分页、失败重试和幂等；
- P9.3 钱包同步路由；
- FIFO UNKNOWN 分离、胜率和新鲜度；
- REAL 账本 ownership；
- reconciliation/AI ownership；
- 财务触发器和迁移；
- ESI GET-only 和 AI 禁止 REAL mutation。

## 3. 并发重复

日志：`logs/19-concurrency-repeat-5x.log`

- 每轮 9 files / 36 tests；
- 5/5 轮通过；
- 每轮 exit code 0。

## 4. 质量门禁

| 命令 | 结果 | 日志 |
| --- | --- | --- |
| `npm run typecheck` | exit 0 | `logs/17-typecheck-final.log` |
| `npm run web:check` | exit 0 | `logs/17-web-check-final.log` |
| `npm test` | 282/282 files，2383/2383 tests | `logs/16-npm-test-after-fixture-fix.log` |
| `npm run lint` | exit 0，`--max-warnings 0` | `logs/17-lint-final.log` |
| `npm run build` | exit 0，237 modules transformed | `logs/17-build-final.log` |
| `npm run audit:public` | Public artifact audit passed | `logs/17-audit-public-final.log` |
| `git diff --check` | exit 0 | 交付前复核 |
| `git diff --cached --check` | exit 0 | 交付前复核 |

构建保留既有 Vite large chunk warning：主 JS 约 741.43 kB，超过 500 kB 建议阈值。该警告不是本阶段新增失败，未扩大范围做 bundle 拆分。

## 5. 测试数据边界

- 使用隔离 `:memory:` 或测试临时 SQLite；
- 使用 mock ESI/fetch；
- 未写生产 REAL 账本；
- 未使用真实 EVE 凭证；
- 未部署；
- 未修改真实生产数据库。

## 6. 结论

代码验证和隔离测试门禁通过；真实环境验证仍为“无”。完整套件通过不能替代真实账户、真实钱包、真实人工核实和真实 FIFO 闭环。

## 7. 最终质量门禁记录（2026-11-05，取代上文较早的计数）

后续新增证据和多进程测试完成后，重新执行了最终门禁。以下日志为最终记录：

| 门禁 | 最终结果 | 日志 |
| --- | --- | --- |
| `npm run typecheck` | 通过 | `logs/22-typecheck-final.log` |
| `npm run web:check` | 通过 | `logs/22-web-check-final.log` |
| `npm test` | 283/283 files，2393/2393 tests 通过 | `logs/23-npm-test-final.log` |
| `npm run lint` | 通过，`--max-warnings 0` | `logs/24-lint-final.log` |
| `npm run build` | 通过，237 modules transformed | `logs/24-build-final.log` |
| `npm run audit:public` | Public artifact audit passed | `logs/25-audit-public-final.log` |
| `git diff --check` | 通过 | `logs/26-diff-check-final.log` |
| `git diff --cached --check` | 通过 | `logs/26-diff-check-final.log` |

补充专项证据：

- P9.3.3.8 专项：8 files / 25 tests 通过，`logs/27-specialized-final.log`；
- P9.3.3.7 历史反例：6 files / 35 tests 通过，`logs/20-historical-p9331-p9337.log`；
- P9.3.3.1–P9.3.3.7 历史单测反例：33 files / 171 tests 通过，`logs/20b-historical-unit-p9331-p9337.log`；
- 并发重复：10 files / 37 tests，5/5 轮通过，`logs/21-concurrency-repeat-5x-final.log`。

测试摘要未报告 skipped tests。构建仍保留既有 Vite >500 kB chunk warning，最终主 JS 为 744.95 kB；这是性能残余风险，不是测试失败。

边界：以上均为代码检查和隔离 SQLite/mock ESI 验证；真实 EVE 账户、生产数据库、生产迁移、真实钱包分页、浏览器视觉回归和高负载生产并发均未验证。

报告最终校正后再次执行 `git diff --check`、`git diff --cached --check`，并检查 `docs/audit/P9.3.3.8/*.md` 无行尾空白；全部通过，日志为 `logs/28-report-final-check.log`。
