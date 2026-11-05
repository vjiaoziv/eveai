# 15 Snapshot 分页与一致性

## 1. 分页边界

测试：`tests/audit/p9-3.3.9/asset-mirror-and-pagination.test.ts:221`。

覆盖 offset 边界：

- 0
- 1
- 4999
- 5000
- 5001
- 10000

验证：

- 每页来自实际持久化 snapshot items。
- 无静默截断。
- `hasMore` 与 `nextOffset` 正确。
- 无重复或遗漏。

结果：通过。

## 2. latest 切换期间的分页固定

测试：`tests/audit/p9-3.3.9/asset-pagination-and-fencing.test.ts:127` 和 `:195`。

场景：

1. 客户端开始读取旧 snapshot。
2. 同步任务创建新的 latest snapshot。
3. 客户端继续请求旧 snapshot 的下一页。

结果：

- 分页请求保持原 snapshot_id。
- 不混入新 generation 的 items。
- 连续 5 轮通过。

## 3. Generation fencing

测试：`tests/audit/p9-3.3.9/asset-pagination-and-fencing.test.ts:164` 和 `:238`。

场景：

- 旧 generation 的 lease 被新任务回收。
- 旧任务继续尝试 heartbeat 续期。

结果：

- heartbeat 被拒绝。
- 旧任务不能重新获得提交资格。
- 连续 5 轮通过。

## 4. 结论

F-P9337-04 未复现。在隔离 SQLite 和重复 generation 竞争下，分页无静默截断，旧页读取保持一致。

## 5. 限制

- 未执行真实浏览器视觉回归。
- 未在生产大数据量、慢客户端和真实多实例网络条件下测试。
- 未验证生产索引计划和极端分页延迟。

## 6. 证据等级

- 代码验证：已完成。
- 隔离测试数据验证：已完成。
- 真实环境验证：无。
- 尚未验证：生产高负载分页与浏览器端用户体验。
