# 独立对抗性测试

## 1. 新增/保留文件

- `tests/unit/p9-3.3.5-asset-race.test.ts`
- `tests/unit/p9-3.3.5-audit-findings.test.ts`
- `tests/unit/p9-3.3.5-crash-after-mutation.test.ts`
- `tests/unit/p9-3.3.5-generic-asset-stale-commit.test.ts`
- `tests/helpers/p9-3.3.5-race-child.ts`
- `tests/helpers/p9-3.3.4-asset-child.ts` 的审计支持修正

`OBSERVED` 测试的设计含义：测试通过表示不安全行为被成功复现，而不是安全通过。

## 2. 并发与故障注入方法

- 五进程竞争：5 个独立 Node.js 子进程、独立 SQLite 连接、WAL、文件屏障。
- 双进程 job race：父进程验证最终 job/latest/mirror/lease。
- 解绑重绑：确定性文件屏障控制 ESI 响应与 rebind 顺序。
- 事务故障：SQLite trigger 在镜像 INSERT、旧 latest 清除、job COMPLETED 前注入 ABORT。
- 真实崩溃：子进程执行 `DELETE character_assets` 后 SIGKILL，父进程检查 SQLite 恢复状态。
- 路由披露：隔离 Fastify + `app.inject()` + 临时数据库。

没有使用随机 sleep 代替关键并发屏障；父测试只使用文件存在性等待和显式 Promise gate。

## 3. 执行结果

| 测试集 | 结果 |
|---|---|
| 五进程 ownership race | 1/1，5/5 次 |
| 关键协调器/fencing/hash/context/unbind 组 | 7 文件 28/28，5/5 次 |
| 镜像 DELETE 后 SIGKILL | 1/1，5/5 次 |
| SSE `perimeter-radar` | 5/5，5/5 次 |
| P9.3 显式文件组 | 27 文件 154/154 |
| 全量套件 | 255 文件 2238/2238 |

## 4. 失败历史

初次 crash harness 曾出现一次 30 秒超时。原因是测试 harness 的 barrier/child teardown 时序不稳定，不是业务断言被放宽。修正 harness 后，新增 crash 测试连续 5/5 通过。该失败历史保留在本报告中，不能把“最终通过”误写为“从未失败”。

## 5. 独立反例结论

独立测试复现了：

- F-P9335-01：dedupe 后新 job COMPLETED 但 mirror 为空。
- F-P9335-02：新 owner 看到旧 owner snapshot/item。
- F-P9335-03：generic sync 在旧 owner 请求返回后覆盖新 owner 上下文 mirror。
- F-P9335-04：缺少 X-Pages 仍 COMPLETED。
- F-P9335-05：聚合数量溢出安全整数。
- F-P9335-06：malformed wallet journal 被标记 ok/0 rows。

## 6. 证据等级

- 隔离 SQLite、独立进程、Fastify route：已验证。
- 生产网络、生产 SQLite、真实 ESI、真实角色切换：未验证。
