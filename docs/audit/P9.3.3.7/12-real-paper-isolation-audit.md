# 12 REAL/PAPER 隔离审计

## 独立反例

`tests/audit/p9-3.3.7/network-and-safety-boundary-audit.test.ts` 验证：

- 新建 REAL 记录的 `is_paper=0`。
- 直接 `UPDATE ... SET is_paper=1` 被数据库 immutable 触发器拒绝，错误为“非草稿交易事实不可原地覆盖”。
- 插入大量 PAPER position 后重算 FIFO，REAL `real_trade_records` 中没有 `is_paper<>0` 行，`real_fifo_lots` 仍为 0。
- `P93AuditService.integrityCheck()` 没有产生 PAPER 混入/隔离相关 finding。
- AI 工具面没有暴露 `real-ledger`、`record-real-trade`、`rebuild-ledger`、`real-trades`、`inventory/lots` 等 REAL 账本写能力。

另由静态检查和既有测试确认 REAL 使用 `real_*` 表，PAPER 使用独立 `paper_*` 路径。

## 结论

- 未发现 REAL/PAPER 表直接混写或通过 AI/ESI 自动执行交易的路径。
- REAL 内部 owner 隔离仍失败：F-P9337-01 允许新 owner 读取和冲正旧 owner 的 REAL 记录；F-P9337-05 允许继承钱包游标。
- 因此本报告不能得出“REAL 账本整体安全”的结论，只能确认 REAL/PAPER 这一维度的隔离检查通过。

## 门禁与限制

- 最新 `npm test`：271 文件 / 2339 测试全部通过，日志 `logs/p9337-npm-test.log`。
- 未验证真实生产数据库迁移、真实 EVE 账号/钱包、真实交易执行和人工核实后的 FIFO 闭环。
- 证据等级：代码验证 + 隔离 SQLite 测试数据验证；真实环境尚未验证。