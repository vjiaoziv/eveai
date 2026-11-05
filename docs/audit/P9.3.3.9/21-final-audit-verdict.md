# 21 最终审计裁决

## 1. 最终状态

```text
P9_3_3_9_AUDIT_FAILED
```

业务状态：

```text
REAL_ACCOUNTING_READY
```

禁止声明：

```text
REAL_ACCOUNTING_OPERATIONALLY_VERIFIED
REAL_TRADING_READY
```

## 2. 阻断理由

存在未解决 P1：

### F-P9339-01 — Scope 刷新破坏最新资产快照与 Mirror

- 正常 scope 刷新改变 binding digest。
- 新同步无法清除旧 latest，并触发唯一约束失败。
- 当前 digest 下旧 snapshot/mirror 不可见。
- job 明确进入 `FAILED`，但用户资产上下文仍被破坏。
- 稳定复现，未修复。

存在未解决 P2：

### F-P9339-02 — Record-scoped 审计历史错误为空

- SQL 占位符和绑定参数顺序不一致。
- 原 owner 的 record-scoped 审计历史被隐藏。
- 未观察到跨 owner 泄露，但破坏可追溯性。

按本轮验收标准，任一未解决 P0/P1 即必须判定 FAILED，因此无争议。

## 3. 未回归的安全保证

本轮已独立验证：

- P9.3.3.7 五项历史缺陷均未复现。
- REAL 账本跨 owner 读写隔离有效。
- 冲正/更正多进程竞争 5 轮被拒绝。
- 资产 lane 隔离有效。
- 钱包角色固定、能力快照和 scope 检查有效。
- 低 ID 钱包失败不会被高 ID 成功越过。
- 钱包失败队列可恢复且幂等。
- FIFO UNKNOWN 成本已售/未售分离有效。
- 未售 UNKNOWN 不污染确定性已实现盈亏和胜率。
- FIFO 新鲜度在事实变化后为 `STALE`，需显式重算恢复 `CURRENT`。
- 钱包异常余额和资产异常响应保护有效。
- canonical hash、分页、generation fencing、migration 回滚和 SIGKILL 恢复通过隔离测试。
- REAL/PAPER 隔离、人工写账本边界和 ESI GET-only 未回归。

这些正向结论不能抵消 F-P9339-01。

## 4. 测试裁决

- 独立专项：13 files / 48 tests，46 passed，2 failed。
- 完整测试：296 files / 2441 tests，2439 passed，2 failed。
- 历史回归：205 tests 通过。
- `npm test` exit code `1`。
- 类型检查、Web 检查、lint、build、public audit 和 diff whitespace 通过。
- Build 有 `744.95 kB` chunk warning。
- 不把“多数测试通过”写成总体通过。

## 5. 证据等级

### 已通过代码验证

关键路由、lineage predicate、SQL 参数、资产同步事务、钱包能力/游标、FIFO、character sync、migration 和 safety boundary 均已静态追踪。

### 已通过隔离测试数据验证

使用隔离 SQLite、mock ESI、独立进程、SIGKILL、并发 barrier 和重复轮次完成验证。

### 已通过真实环境验证

无。没有使用真实 EVE 账号、真实 token、真实钱包、生产 SQLite 或生产部署。

### 尚未验证

- 真实 OAuth/SSO 和角色切换。
- 真实 ESI 钱包分页、限流和 schema 变化。
- 生产数据库 migration、备份恢复和高负载。
- 真实交易人工核实、FIFO 与盈亏运营闭环。
- 浏览器视觉和高并发性能。

## 6. 下一阶段

必须进入：

```text
P9.3.3.10 — Targeted Remediation
```

不得进入 P9.3.4/P9.4，不得部署生产，不得修改生产数据库，不得开放真实交易自动执行，不得新增 AI/Agent 写 REAL 账本能力。

修复完成后必须重新执行独立审计，不得以本次报告的正向部分替代复审。
