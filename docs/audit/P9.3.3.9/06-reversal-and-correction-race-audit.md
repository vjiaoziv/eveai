# 06 冲正与更正竞态审计

## 1. 审计目标

验证以下竞争场景：

- 授权检查后角色解绑或重新绑定。
- stale owner 与 new owner 并发冲正。
- 重复冲正。
- 更正请求与冲正并发。
- 多连接、多进程下财务事实是否保持不变。

## 2. 路由与服务边界

REAL 账本冲正/更正路由位于 `src/web/p9-3-routes.ts`：

- `/records/:recordId/reverse`
- `/records/:recordId/correct`

这些路由先解析当前 linked character 和 REAL lineage，再把 lineage 传给 ledger service。写入由数据库事务和财务触发器保护，AI/工具层未暴露 REAL mutation 能力。

## 3. 独立并发测试

测试：`tests/audit/p9-3.3.9/multiprocess-ledger-race.test.ts:196`。

方法：

- 启动两个独立进程。
- 使用共享 barrier 让 stale-owner 与 new-owner 请求同时进入。
- 连续重复 5 轮。

结果：

- stale owner 与 new owner 的冲正均被拒绝。
- 成功轮次没有跨 owner 修改原交易。
- 没有观察到授权检查后写入窗口。
- 5/5 轮通过。

## 4. 更正与其他子资源

测试：`tests/audit/p9-3.3.9/ledger-child-authorization.test.ts`。

新 owner 对以下操作均被拒绝：

- 提交核实。
- 核实/驳回。
- 冲正。
- 更正。
- 证据状态修改。
- 证据关联。

原始记录和证据快照在请求前后完全一致。

## 5. 结论

在代码阅读、隔离 SQLite 和多进程竞争测试范围内，未发现跨 owner 冲正或更正绕过，F-P9337-01 的竞态修复未回归。

本结论不覆盖真实生产数据库锁竞争、网络延迟和生产多实例环境。

## 6. 证据等级

- 代码验证：已完成。
- 隔离测试数据验证：已完成，5 轮多进程。
- 真实环境验证：无。
- 尚未验证：真实生产数据库高并发、长事务、崩溃恢复期间的人工冲正竞争。
