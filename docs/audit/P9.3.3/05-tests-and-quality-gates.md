# 05 测试与质量门禁

## 验证状态

以下结果全部来自静态检查、构建检查或隔离 SQLite 测试，不是生产环境结果。

## 最终完整门禁

最终代码状态串行执行结果：

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| npm run typecheck | 通过，exit 0 | TypeScript 全项目检查 |
| npm run web:check | 通过，exit 0 | Web TypeScript 检查 |
| npm test | 通过，exit 0 | 272 个测试文件、2344 项测试通过，耗时 166.87s |
| npm run lint | 通过，exit 0 | eslint src/ web/src/ --max-warnings 0 |
| npm run build | 通过，exit 0 | 后端 tsc + Vite 237 modules 构建成功 |
| npm run audit:public | 通过，exit 0 | Public artifact audit passed |
| git diff --check | 通过，exit 0 | 无尾随空白或补丁格式错误 |

完整测试日志：/tmp/p9333-8-test.log；类型检查、Web 检查、lint、构建和公共产物审计日志分别为 /tmp/p9333-8-*.log。

## P9.3.3 专项覆盖

完整套件包含 P9.3.3、P9.3.3.1、P9.3.3.2、P9.3.3.3、P9.3.3.4、P9.3.3.5、P9.3.3.6 和 P9.3.3.7 回归文件，覆盖：

- P93EsiEvidenceService 钱包同步；
- P9.3 钱包同步路由；
- 角色切换与解绑并发；
- 能力快照缺失和过期；
- 钱包 scope 缺失；
- 钱包分页超限、空后续页和不完整分页；
- 增量游标失败重试；
- 持久失败记录和跨进程租约；
- 重复导入幂等；
- 人工核实事实保护；
- FIFO UNKNOWN 成本分离；
- FIFO 结果哈希稳定；
- 钱包异常余额保护；
- 资产异常响应、原子快照、角色重绑和陈旧任务 fencing；
- FIFO 计算新鲜度 CURRENT/STALE/NEVER_CALCULATED。

主要测试文件：

- tests/unit/p9-3.3-evidence.test.ts
- tests/unit/p9-3.3-wallet-routes.test.ts
- tests/unit/p9-3.3-fifo.test.ts
- tests/unit/p9-3.3-character-sync.test.ts
- tests/unit/p9-3.3.1-audit-asset-integrity.test.ts
- tests/unit/p9-3.3.1-audit-freshness.test.ts
- tests/unit/p9-3.3.1-audit-wallet-concurrency.test.ts
- tests/unit/p9-3.3.2-asset-integrity.test.ts
- tests/unit/p9-3.3.2-freshness-contract.test.ts
- tests/unit/p9-3.3.2-ledger-evidence-idempotency.test.ts
- tests/unit/p9-3.3.2-wallet-balance-integrity.test.ts
- tests/unit/p9-3.3.2-wallet-cross-connection-lease.test.ts
- tests/unit/p9-3.3.2-wallet-lease-integrity.test.ts
- tests/unit/p9-3.3.2-wallet-multiprocess-lease.test.ts
- tests/unit/p9-3.3.3-asset-race.test.ts
- tests/unit/p9-3.3.4-asset-canonical-hash.test.ts
- tests/unit/p9-3.3.4-asset-character-context.test.ts
- tests/unit/p9-3.3.4-asset-fencing.test.ts
- tests/unit/p9-3.3.4-asset-job-atomicity.test.ts
- tests/unit/p9-3.3.4-asset-migration.test.ts
- tests/unit/p9-3.3.4-asset-unbind-race.test.ts
- tests/unit/p9-3.3.5-asset-race.test.ts
- tests/unit/p9-3.3.5-audit-findings.test.ts
- tests/unit/p9-3.3.5-crash-after-mutation.test.ts
- tests/unit/p9-3.3.5-generic-asset-stale-commit.test.ts

## 测试隔离

- 金融与资料同步回归使用独立 better-sqlite3 实例，多数为 :memory:。
- ESI 使用 mock 或受控 fetch，不访问真实账号。
- 未写入生产 REAL 账本，未访问生产数据库。
- 没有跳过测试、关闭 lint 规则、放宽财务数据库触发器或修改断言来伪造通过。

## 非阻断告警

- Vitest 输出既有 UNDICI-EHPA experimental 警告。
- 部分既有测试输出业务日志和 usage_events 缺失日志，但退出码为 0。
- Vite 主 JS chunk 为 741.43 kB，超过 500 kB 建议阈值；这是既有性能告警，不阻断构建，也未在本阶段扩大处理范围。

## 真实环境

未执行真实账号、真实钱包、生产数据库或生产部署验证。因此不能声明真实业务闭环已完成运行验证。

## P9.3.3.7 审计回归与专项快照

本轮专项审计回归使用隔离 SQLite、mock fetch 和隔离临时数据库，覆盖 41 个测试文件、245 个测试，全部通过。

审计回归文件：

- tests/audit/p9-3.3.7/asset-consistency-audit.test.ts
- tests/audit/p9-3.3.7/owner-ledger-isolation-audit.test.ts
- tests/audit/p9-3.3.7/wallet-owner-cursor-audit.test.ts
- tests/audit/p9-3.3.7/wallet-cursor-integrity-audit.test.ts
- tests/audit/p9-3.3.7/network-and-safety-boundary-audit.test.ts
- tests/audit/p9-3.3.7/historical-regression-audit.test.ts

其中资产一致性专项为 3/3 通过，资产同步与资产路由组合测试为 14/14 通过。当前完整套件为 272 个测试文件、2344 个测试全部通过，耗时 166.87s；Vite 转换 237 modules。主 JS bundle 为 741.43 kB，gzip 211.40 kB，仅有既有的 chunk size 警告。
