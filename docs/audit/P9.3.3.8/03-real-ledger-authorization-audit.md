# 03 REAL 账本授权审计

## 1. 审计目标

确认 REAL 账本的所有读取、写入和派生计算都以持久 owner/chat/epoch 为授权条件，且跨所有者请求不能通过 ID 猜测、路由参数、FIFO 子查询或 AI 上下文绕过。

## 2. 路由入口

P9.3 Web 路由先解析认证 session、目标角色和显式 lineage。`char.characterId`、owner、chat、epoch 由同一请求固定；缺失 lineage 直接拒绝，不进入服务层。

重点入口包括：

| 入口类型 | 授权要求 |
| --- | --- |
| 账本列表/详情 | 目标角色属于 session，使用该角色 lineage |
| 手工创建/草稿更新 | 人工 actor，目标角色和 lineage 一致 |
| verify/reject/correct/reverse | 人工 actor，写前写后绑定校验 |
| evidence add | 证据与目标账本 lineage 一致 |
| FIFO recalculate | 仅计算当前 lineage 的已核实事实 |
| performance/lots/reconciliation | 查询条件带 owner/chat/epoch |
| P9 overview/AI analysis | 只聚合当前 lineage |
| ESI wallet sync | 固定 characterId、owner、chat、epoch；能力快照必须绑定角色 |

钱包同步路由把 `{ userId, chatId, characterId: char.characterId }` 传入服务，并显式传入 lineage。服务再次固定上下文。

## 3. 跨 owner 行为

跨 owner 的读取返回空结果或 404；跨 owner 的写操作返回拒绝错误，不产生任何事实、费用、证据、事件或 FIFO 状态变化。测试没有期望“返回旧数据后由前端隐藏”，而是要求数据库层查询本身不可见。

覆盖场景：

- 新 owner 按旧 record_id 查详情；
- 新 owner 列出旧账本；
- 新 owner 验证、拒绝、更正、冲正旧记录；
- 新 owner 追加旧记录证据；
- 新 owner 运行 FIFO 或读取旧计算；
- 新 owner 运行 reconciliation 或读取旧 case；
- 新 owner 调用 overview 和 AI analysis。

## 4. 授权实现

### 4.1 账本服务

`P93LedgerService` 每次读写先解析 scope，并在 mutation transaction 内校验当前绑定。记录、费用、证据关联、事件和 correction/reversal 写入均带 lineage 列。

### 4.2 审计和对账

`P93AuditService` 对 event、calculation run、reconciliation run 使用 alias-aware predicate；`P93ReconciliationService` 对 snapshot、valuation、trade、FIFO、change 和 AI 输入分别使用同一 lineage。

### 4.3 P9 控制面

opportunity、plan、job 和 settings 使用 owner/chat/epoch 控制面 lineage；同一角色不同 lane 不共享设置、机会、计划或运行历史。

### 4.4 AI 面

AI analysis 只接收当前 owner 的上下文；其输入查询不是“先查全角色再在 prompt 里裁剪”。`p9-ai-analysis.ts` 的 trade、fee、consumption、lot 和 opportunity 子查询都带 lineage predicate。AI 仍只能产生只读分析，不能修改 REAL 账本。

## 5. 失败码和用户反馈

| 情况 | 结果 |
| --- | --- |
| 未认证/无 mutation session | 拒绝 |
| 目标角色不属于 session | 拒绝 |
| lineage 缺失或无法唯一解析 | 拒绝 |
| 钱包 scope 缺失 | 403 `WALLET_SCOPE_MISSING`，发出明确重授权提示 |
| 目标角色在同步中解绑/换 owner | 403 `IDENTITY_CHANGED`，不写账本 |
| ESI 失败或分页不完整 | 502/等价的同步失败，不推进游标 |
| 畸形交易 | 持久失败状态，422/错误结果，不推进游标 |

错误消息不回显 token 或原始敏感凭证。

## 6. 验证证据

- `tests/audit/p9-3.3.8/real-ledger-ownership-isolation.test.ts`：3 个用例。
- `tests/audit/p9-3.3.8/control-plane-lineage-isolation.test.ts`：3 个用例。
- `tests/audit/p9-3.3.8/reconciliation-ownership.test.ts`：6 个用例。
- 完整专项结果见 `logs/18-specialized-final.log`。
- 完整套件见 `logs/16-npm-test-after-fixture-fix.log`。

## 7. 边界

以上是代码和隔离 SQLite 路由验证；没有真实生产用户、真实角色解绑或真实 OAuth 的授权攻击测试。
