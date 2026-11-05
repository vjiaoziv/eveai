# 04 REAL 账本所有权隔离

## 1. 检查目标

验证角色解绑、重新绑定以及 owner 变化后，旧 owner 的 REAL 交易、证据、审计历史、FIFO 关联、冲正和更正记录不能被新 owner 或无关第三方读取或操作。

## 2. 代码路径

关键实现位于：

- `src/trading/p9-3-lineage.ts:73-86`：REAL lineage predicate。
- `src/web/p9-3-routes.ts`：REAL 交易、证据、审计、冲正和更正路由。
- `src/trading/p9-3-ledger-service.ts`：交易与证据的 owner-aware 查询和写入。

业务记录使用 `owner_user_id + owner_chat_id + binding_epoch` 作为隔离命名空间；历史 owner 不因角色重绑自动继承给当前 owner。

## 3. 独立反例

测试：`tests/audit/p9-3.3.9/real-ledger-owner-isolation.test.ts`。

测试构造：

1. Owner A 绑定角色并创建 REAL 交易。
2. A 关联证据、核实交易并生成审计/FIFO 数据。
3. A 解绑，Owner B 绑定同一角色。
4. B 使用真实路由和 service 尝试读取及修改所有已发现子资源。

结果：

- 新 owner 的读取被拒绝。
- 新 owner 的修改请求全部被拒绝。
- 原 owner 的交易、证据和审计历史未被改变。
- 未发现可通过伪造 ownerId/chatId/laneId 绕过当前 lineage 的路径。

## 4. 多进程验证

测试：`tests/audit/p9-3.3.9/multiprocess-ledger-race.test.ts`。

使用两个独立进程和共享 barrier，连续 5 轮尝试 stale-owner/new-owner 冲正：

- 5/5 轮拒绝。
- 原交易事实未变化。
- 未出现跨进程授权检查后写入。

## 5. 结论

F-P9337-01 未复现。REAL 账本 owner 隔离在本轮代码阅读、路由级测试和多进程隔离测试范围内保持有效。

F-P9339-02 是 record-scoped 审计历史查询的参数顺序问题，不影响本文件中新 owner 被拒绝的结论；详见 `05-evidence-and-audit-history-authorization.md`。

## 6. 证据等级

- 代码验证：已完成。
- 隔离测试数据验证：已完成。
- 真实环境验证：无。
- 尚未验证：真实 SSO token 生命周期、真实角色解绑并发、生产数据库上的历史迁移。
