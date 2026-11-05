# 03 P9.3.3.7 历史缺陷独立复核

## 1. 复核方法

本轮没有只运行 P9.3.3.7/P9.3.3.8 的既有测试，而是在 `tests/audit/p9-3.3.9/` 中重新构造关键反例，并调用当前生产服务、路由、SQLite schema 和隔离数据库。

历史结果：

| 套件 | 文件 | 测试 | 退出码 | 日志 |
|---|---:|---:|---:|---|
| P9.3.3.7 专项 | 6 | 35 | 0 | `logs/11-p9337-history-suite.log` |
| P9.3.3.8 专项 | 8 | 25 | 0 | `logs/12-p9338-history-suite.log` |
| P9.3.3.1–P9.3.3.6 | 29 | 139 | 0 | `logs/13-p9331-p9336-history-suite.log` |

## 2. 五项历史缺陷

### F-P9337-01（原 P0）：REAL 账本跨 owner 访问

独立测试：`tests/audit/p9-3.3.9/real-ledger-owner-isolation.test.ts`。

结果：新 owner 无法读取旧 owner 的交易、证据、审计事件、FIFO 关联和冲正记录，也无法核实、驳回、冲正或更正旧记录；原 owner 历史保持不变。

结论：未复现，历史修复有效。

### F-P9337-02（原 P1）：不同 chat lane 的资产 mirror 相互覆盖

独立测试：`tests/audit/p9-3.3.9/asset-mirror-and-pagination.test.ts`。

结果：同一角色的两个 lane 经重复同步仍保持独立 latest snapshot 和 mirror；一轮及五轮替换均通过。

结论：未复现，历史修复有效。

### F-P9337-03（原 P2）：不同 item set 被错误判定一致

独立测试：`tests/audit/p9-3.3.9/asset-mirror-and-pagination.test.ts`。

结果：两个持久化 item set 即使 count 和 quantity 总量相同，只要 item 明细不同，canonical hash 即不同，不会被去重或误报一致。

结论：未复现，历史修复有效。

### F-P9337-04（原 P2）：snapshot detail 静默截断

独立测试：`tests/audit/p9-3.3.9/asset-mirror-and-pagination.test.ts`。

结果：0/1/4999/5000/5001/10000 边界均完整分页，返回 `hasMore`/`nextOffset`，无静默截断、重复或遗漏。

结论：未复现，历史修复有效。

### F-P9337-05（原 P1）：钱包游标跨 owner 继承

独立测试：`tests/audit/p9-3.3.9/wallet-adversarial.test.ts`。

结果：角色转移后，旧 owner 的 durable cursor 和失败状态不进入新 owner lineage；新 owner 不继承旧边界。

结论：未复现，历史修复有效。

## 3. 新增反例的边界

历史缺陷修复通过不推翻本轮新增缺陷：

- F-P9339-01 是稳定 binding 下 scope 刷新导致 latest snapshot/digest 不一致。
- F-P9339-02 是审计查询参数绑定错误。

两者不在 P9.3.3.7 五项历史缺陷范围内。

## 4. 证据等级

- 代码验证：已完成相关服务、SQL 和路由追踪。
- 隔离测试数据验证：205 项历史测试通过；本轮独立反例也通过对应安全断言。
- 真实环境验证：无。
- 尚未验证：真实 ESI、真实角色切换、真实生产数据迁移。
