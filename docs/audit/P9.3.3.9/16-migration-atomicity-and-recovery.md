# 16 Migration 原子性与恢复

## 1. 回滚测试

测试：`tests/audit/p9-3.3.9/migration-rollback.test.ts:142`。

验证：

- 遗留 REAL 记录、证据和钱包游标保留。
- owner-aware uniqueness 正确建立。
- 财务事实不可变触发器未被削弱。
- migration 重复执行保持幂等。

结果：通过。

## 2. 注入失败后的回滚

测试：`tests/audit/p9-3.3.9/migration-rollback.test.ts:200`。

在重建资产结构后注入失败，验证：

- 游标回滚到 migration 前状态。
- 资产重建整体回滚。
- 不留下半完成 schema 或部分数据。
- 旧有效数据仍可读取。

结果：通过。

## 3. SIGKILL 恢复

测试：`tests/audit/p9-3.3.9/migration-process-interruption.test.ts:138`。

使用 `migration-kill-child.ts` 启动独立进程，在 migration 关键时刻发送 SIGKILL；连续 5 轮。

结果：

- 遗留 rows、cursor 和 asset mirror 未丢失。
- 重启后 migration 可继续或安全回滚。
- 未出现半提交状态。

## 4. 与资产同步的关系

migration recovery 通过不等于 scope-refresh latest 指针问题已修复。F-P9339-01 是正常运行中的 digest/唯一索引语义问题，不是 migration 崩溃恢复缺陷。

## 5. 结论

在隔离 SQLite 范围内，migration 的原子性、遗留数据保护、注入失败回滚和 SIGKILL 恢复均通过。

## 6. 证据等级

- 代码验证：已完成。
- 隔离测试数据验证：已完成，包含 5 轮 SIGKILL。
- 真实环境验证：无。
- 尚未验证：生产数据库体量、文件系统行为、备份恢复、在线 migration 和真实部署中断。
