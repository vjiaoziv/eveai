# 08 测试与质量门禁

## 全量门禁

所有命令在 `/home/ubuntu/projects/eveai` 执行，测试仅使用隔离 SQLite。

| 命令 | 实际结果 | 退出码 |
| --- | --- | --- |
| `npm run typecheck` | TypeScript 检查通过 | 0 |
| `npm run web:check` | Web TypeScript 检查通过 | 0 |
| `npm test` | 244 个测试文件通过，2200 项测试通过 | 0 |
| `npm run lint` | ESLint `--max-warnings 0` 通过 | 0 |
| `npm run build` | 服务端 TypeScript 与 Vite 生产构建通过 | 0 |
| `npm run audit:public` | `Public artifact audit passed.` | 0 |
| `git diff --check` | 无空白错误 | 0 |

Vite 构建包含一个非阻断体积提示：`web/dist/assets/index-HFnpYwiR.js` 为 610.83 kB，超过 500 kB 建议阈值。该提示不是构建失败。

## 独立测试文件退出码

以下每个测试文件均以独立 Vitest 进程执行，未合并运行、未跳过测试。

| 测试文件 | 退出码 | 实际结果 |
| --- | ---: | --- |
| `tests/unit/p9-3.3.1-audit-asset-integrity.test.ts` | 0 | 4 passed |
| `tests/unit/p9-3.3.1-audit-wallet-concurrency.test.ts` | 0 | 8 passed |
| `tests/unit/p9-3.3.1-audit-freshness.test.ts` | 0 | 1 passed |
| `tests/unit/p9-3.3.2-asset-integrity.test.ts` | 0 | 16 passed |
| `tests/unit/p9-3.3.2-wallet-lease-integrity.test.ts` | 0 | 5 passed |
| `tests/unit/p9-3.3.2-wallet-cross-connection-lease.test.ts` | 0 | 1 passed |
| `tests/unit/p9-3.3.2-wallet-multiprocess-lease.test.ts` | 0 | 1 passed |
| `tests/unit/p9-3.3.2-ledger-evidence-idempotency.test.ts` | 0 | 3 passed |
| `tests/unit/p9-3.3.2-freshness-contract.test.ts` | 0 | 3 passed |
| `tests/unit/p9-3.3.2-wallet-balance-integrity.test.ts` | 0 | 2 passed |
| `tests/unit/p9-3.3-character-sync.test.ts` | 0 | 8 passed |
| `tests/unit/p9-3.3-evidence.test.ts` | 0 | 13 passed |
| `tests/unit/p9-3.3-fifo.test.ts` | 0 | 6 passed |
| `tests/unit/p9-3.3-wallet-routes.test.ts` | 0 | 5 passed |
| `tests/unit/p9-3-real-accounting.test.ts` | 0 | 7 passed |
| `tests/unit/p9-3-hardening.test.ts` | 0 | 33 passed |
| `tests/unit/p9-safety-and-ai.test.ts` | 0 | 4 passed |
| `tests/unit/asset-sync.test.ts` | 0 | 9 passed |

## 关键新增覆盖

- 跨 SQLite 连接租约：`p9-3.3.2-wallet-cross-connection-lease.test.ts`。
- 真实独立 Node 子进程持有同角色租约：`p9-3.3.2-wallet-multiprocess-lease.test.ts`。父进程通过 SQL 执行屏障确认已进入租约争抢，子进程通过 stdout 明确确认持锁/释放，不以随机 sleep 作为正确性依据。
- 声明多页时首/后空页失败，以及合法的空单页钱包成功：`p9-3.3-evidence.test.ts`。
- 兼容 overview、P9.3 ledger overview/performance/costs 与 AI REAL 汇总均保留 freshness：`p9-3.3.2-freshness-contract.test.ts`。

## 需求覆盖矩阵

| 要求 | 覆盖 |
| --- | --- |
| 钱包同步服务级测试 | `p9-3.3-evidence.test.ts` |
| 钱包同步路由测试 | `p9-3.3-wallet-routes.test.ts` |
| 角色切换并发测试 | evidence、wallet-routes、audit-wallet-concurrency |
| 能力快照缺失/过期 | evidence |
| 缺少钱包 scope | evidence、wallet-routes |
| 钱包分页超限/空页完整性 | evidence、wallet-routes |
| 增量游标失败重试 | evidence、wallet-lease-integrity |
| 同角色跨进程同步 | wallet-multiprocess-lease |
| 重复导入幂等 | evidence、ledger-evidence-idempotency |
| FIFO UNKNOWN 成本分离 | `p9-3.3-fifo.test.ts` |
| 异常钱包余额保护 | wallet-balance-integrity、character-sync |
| 资产镜像异常响应保护 | asset-integrity、audit-asset-integrity、asset-sync |
| FIFO 计算新鲜度与消费者传播 | fifo、freshness-contract、audit-freshness |

## 测试数据隔离

- 单元测试使用独立的 better-sqlite3 内存数据库或系统临时目录数据库。
- 跨连接与跨进程租约测试使用 `mkdtemp` 创建临时 SQLite 文件，并在测试结束清理。
- 未连接生产数据库，未写入生产 REAL 账本，未应用生产迁移。

## 验证边界

以上是代码、隔离测试和构建验证，不等同于真实 EVE 账户、真实 ESI 响应或生产环境验证。
