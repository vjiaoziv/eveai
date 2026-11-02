# P8.5.6 连续全量回归稳定性

## 稳定性修复

- DraftSystem 立即事务，修复多进程 draftId 竞争。
- 资金扣减条件 SQL。
- 凭证 INSERT OR IGNORE。
- 测试 worker 将 20 个进程改为 10 进程 × 10 次，共 100 次竞争。
- Perimeter pursuit advisory 先等待持久化再断言。
- Vitest 使用确定性串行文件执行，避免全局 fake timer/SSE 测试互相干扰。

## 连续三次结果

日志：

- docs/audit/P8.5.6/logs/full-run-1.log
- docs/audit/P8.5.6/logs/full-run-2.log
- docs/audit/P8.5.6/logs/full-run-3.log

每次：

~~~text
Test Files  211 passed (211)
Tests       2009 passed (2009)
~~~

耗时分别为 117.50s、110.74s、110.78s。

## 其他门禁

- TypeScript：通过，logs/typecheck.log。
- Lint：0 errors / 0 warnings，logs/lint.log。
- Build：通过且无字体警告，logs/build.log。
- 独立验收专项：8 文件、40 项通过，logs/independent-acceptance.log。

结论：连续 3 次全项目测试全部通过。
