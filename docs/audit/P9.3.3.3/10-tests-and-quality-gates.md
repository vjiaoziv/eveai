# 10 测试与质量门禁

## 1. 执行基线

- 日期：2026-11-04（Asia/Shanghai）
- 分支：deploy/eve-ai-agent
- HEAD：9e8e8b32d0e065c6d8479140f94662087193279d
- 工作区：保留任务开始前已有的 staged、unstaged 与 untracked 修改
- 数据库：专项测试使用隔离临时 SQLite；未写入生产 REAL 账本
- 外部环境：未调用真实 ESI 钱包或资产接口

## 2. 质量门禁结果

| 命令 | 退出码 | 实际结果 |
|---|---:|---|
| `npm run typecheck` | 0 | 通过 |
| `npm run web:check` | 0 | 通过 |
| `npm test` | 1 | 245 个测试文件、2204 项；244 个文件、2200 项通过；1 个文件、4 项失败；跳过 0 项 |
| `npm run lint` | 0 | 通过 |
| `npm run build` | 0 | 通过；Vite 报告单个 chunk 超过 500 kB 的警告 |
| `npm run audit:public` | 0 | Public artifact audit passed |
| `git diff --check` | 0 | 通过，无空白错误 |

因此，代码静态检查、前端检查、lint、构建和公共制品审计通过，但完整测试门禁失败，不能给出整体通过结论。

## 3. 完整测试失败范围

最终一次全量测试：

~~~text
Test Files: 1 failed | 244 passed (245)
Tests:      4 failed | 2200 passed (2204)
Skipped:    0
Exit code:  1
~~~

全部失败均来自独立对抗性反例：

~~~text
tests/unit/p9-3.3.3-asset-race.test.ts
~~~

失败项：

1. `FINDING: asset sync must reject a characterId that contradicts the pinned user context`
2. `FINDING: canonical hash must not dedupe away location_type/is_singleton/blueprint-copy changes`
3. `FINDING: two processes must not both pass RUNNING check and let an older response overwrite the newer snapshot`
4. `FINDING: asset sync must abort when the pinned character is unlinked during the ESI response`

对应缺陷：

- 第 1 项：F-P9333-03；
- 第 2 项：F-P9333-02；
- 第 3 项：F-P9333-01；
- 第 4 项：F-P9333-04。

## 4. 并发反例稳定性

独立测试文件新增第四项反例后，连续执行 3 次，三次结果均为：

~~~text
Test Files: 1 failed
Tests:      4 failed
~~~

并发测试的确定性 barrier 保证两个子进程都先通过 RUNNING 查询，再允许继续。不同执行顺序下观察到：

- 两个进程均完成，生成 2 个 completed job 和 2 个快照，旧响应覆盖新响应；
- 两个进程均插入 RUNNING job，其中一个在 latest 唯一索引处失败，另一个完成，数据库仍留下 2 个 job。

两种结果都违反“每角色单一有效同步者”，因此该反例不是依赖某一种提交顺序才失败。

## 5. 负载相关不稳定测试

首次全量测试中，除本轮 4 个反例外，还出现：

~~~text
tests/integration/perimeter-radar.test.ts
Perimeter live radar, end to end over real SSE
does not lose a kill that lands before the first bubble, nor publish a bubble the pilot jumped out of
Error: jump location failed: timed out waiting for jump location
~~~

首次全量结果为：

~~~text
Test Files: 2 failed | 243 passed (245)
Tests:      5 failed | 2199 passed (2204)
~~~

随后：

- 该文件单独运行 1 次通过；
- 再连续运行 3 次均通过；
- 最终第二遍全量测试未再出现该失败，只保留本轮 4 个反例。

因此将该测试记录为**负载相关不稳定测试**，不把它归为 P9.3.3 已确认业务缺陷，也不通过删除或跳过来消除失败。

## 6. 专项测试覆盖

在完整测试中，P9.3.3 相关既有专项测试均通过，覆盖：

- 能力快照建立与钱包 scope 检查；
- 固定角色上下文和角色切换并发；
- 钱包分页超限、失败游标阻塞和幂等重试；
- 钱包交易严格字段校验；
- FIFO 已售/未售 UNKNOWN 成本分离；
- FIFO freshness 的 CURRENT、STALE、NEVER_CALCULATED；
- 非法钱包余额保护；
- 资产字段严格校验、重复 item_id、分页畸形、后续页失败和数据库事务回滚；
- 钱包租约的跨连接与多进程基础测试；
- REAL/PAPER 与 ESI GET-only 边界。

这些通过结果只表示对应隔离测试场景通过，不抵消本轮 4 个失败反例。

## 7. 测试独立性说明

本轮新增独立反例位于：

~~~text
tests/unit/p9-3.3.3-asset-race.test.ts
~~~

该文件使用：

- 隔离内存或临时 SQLite；
- 显式数据库迁移；
- stub ESI 响应；
- 独立 Node.js 子进程；
- 文件 barrier 和 SQLite prepare Proxy；
- 角色解绑注入点；
- 不依赖随机 sleep 的确定性交错。

新增测试只验证审计预期，没有修改业务代码来使其通过。

## 8. 测试真实性声明

- 未删除失败测试；
- 未跳过失败测试；
- 未弱化断言；
- 未修改数据库财务触发器以换取通过；
- 未把隔离 SQLite 测试描述成生产验证；
- 未因测试失败而宣称完成。

## 9. 门禁结论

~~~text
TYPECHECK: PASS
WEB_CHECK: PASS
UNIT_INTEGRATION_TESTS: FAIL
LINT: PASS
BUILD: PASS WITH WARNING
PUBLIC_AUDIT: PASS
OVERALL: FAIL
~~~

最终审计状态保持：

~~~text
P9_3_3_3_AUDIT_FAILED
~~~
