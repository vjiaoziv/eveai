# 生产验证边界

## 1. 明确未执行

本轮没有：

- 连接生产 EVE 账户或生产 ESI token；
- 读取或写入生产数据库；
- 执行生产 schema migration；
- 部署生产服务；
- 触发真实角色解绑、所有权转移或重新绑定；
- 生成、核实或修改真实交易记录；
- 执行真实订单、资产转移、ISK 转账或合同操作；
- Git commit、push 或代码冻结。

## 2. 分类

### 已通过代码验证

- 协调器事务申请与最终 fencing 链。
- canonical hash 字段和版本判断。
- binding epoch 触发器。
- ESI GET-only 两层策略。
- generic sync 与协调器写路径的差异。
- 所有权转移清理范围不包含 `real_asset_*`。

### 已通过隔离测试数据验证

- 两个和五个独立进程竞争。
- 独立 SQLite 文件、WAL、busy timeout。
- 事务触发器回滚。
- 实际 mirror DELETE 后 SIGKILL 的 SQLite 恢复。
- Fastify 路由旧历史披露。
- malformed ESI mock 响应。
- 钱包/FIFO/REAL/PAPER 专项回归。

### 尚未验证

- 真实 ESI 的 `X-Pages` 行为、分页变化、响应字段和 rate-limit/latency。
- 生产数据库锁竞争、文件系统语义、WAL checkpoint、迁移耗时和回滚。
- 真实 OAuth scope 撤销、refresh token 失效、远端 session 失效。
- 真实服务多实例、scheduler 长跑、时钟漂移和 30 分钟以上同步。
- 真实钱包日志与资产数据、人工核实、FIFO、盈亏闭环。
- 生产所有权转移和跨用户数据隔离。
- 生产告警、日志保留和事故恢复。

## 3. 状态边界

`REAL_ACCOUNTING_READY` 仅表示当前工程基线具备继续准备的条件，不表示运营闭环完成。

不得声明：

`REAL_ACCOUNTING_OPERATIONALLY_VERIFIED`

## 4. 发布建议

当前存在 P1 审计缺陷：

- 暂停 commit、push、代码冻结和生产部署。
- 暂停 P9.3.4。
- 暂停 P9.4。
- 修复后重新进行独立对抗性审计。
