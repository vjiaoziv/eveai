> **状态说明（P9.3.1 复核）**：本目录是 P9.3 初版交付记录，其中“自动核实 ESI 钱包交易”“证据关系不可变”等部分描述已被 P9.3.1 的代码审计发现并修正。当前权威审计、测试与真实环境状态以 [`../P9.3.1/README.md`](../P9.3.1/README.md) 为准。
# P9.3 交付索引

1. `01-architecture-data-flow.md`：总体架构与数据流。
2. `02-transaction-ledger-design.md`：交易账本设计。
3. `03-evidence-verification.md`：交易证据与核实规则。
4. `04-fifo-cost-accounting.md`：FIFO 成本核算。
5. `05-pnl-calculation.md`：盈亏计算口径。
6. `06-asset-reconciliation.md`：资产对账。
7. `07-security-boundaries.md`：安全边界与权限审计。
8. `08-testing-real-validation.md`：测试及真实环境验证。

交付状态：`REAL_ACCOUNTING_READY` 仅表示真实交易记录、证据、FIFO、盈亏、对账、审计和中文工作台具备使用条件。当前没有真实交易样本，真实 ESI 成交/钱包/订单/人工核实样本验证仍待在具备角色权限的真实环境完成；不代表自动交易开放或投资策略盈利验证。