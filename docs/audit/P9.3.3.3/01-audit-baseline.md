# 01 审计基线与工作区状态

## 1. 权威仓库

- Windows UNC：\\wsl.localhost\Ubuntu-24.04\home\ubuntu\projects\eveai
- WSL：/home/ubuntu/projects/eveai
- 分支：deploy/eve-ai-agent
- HEAD：9e8e8b32d0e065c6d8479140f94662087193279d
- 远端同名分支在当前本地视图中指向同一提交

最近提交：

~~~text
9e8e8b3 fix(ci): remove prohibited artifacts and correct expiry gate
2f11d3a feat(audit): complete project quality and P9.3 financial verification
7e65027 docs(p9.3.2): record production deployment and version verification
66ec798 feat(p9.3): deliver real accounting ledger and P9.3.1 hardening
6d78d59 feat(p9.2): add real asset inventory and valuation workbench
~~~

## 2. 工作区保护

审计开始前工作区已存在大量 staged、unstaged 和 untracked 文件，包含：

- P9.3.3、P9.3.3.1、P9.3.3.2 代码修复；
- 既有专项测试；
- 历史审计报告；
- 文档目录整理产生的 staged rename；
- 本轮新增 tests/unit/p9-3.3.3-asset-race.test.ts。

本轮未执行 reset --hard、clean、checkout -- .、restore .，未覆盖或清理既有修改。业务工作区仍保持脏状态。

当前主要 unstaged 业务代码差异：

~~~text
src/assets/asset-sync-service.ts
src/db/migrations.ts
src/eve/character-sync.ts
src/trading/p9-3-evidence-service.ts
src/trading/p9-3-fifo-service.ts
src/trading/p9-3-ledger-service.ts
src/trading/p9-3-types.ts
src/web/p9-3-routes.ts
src/web/p9-routes.ts
web/src/components/P93AccountingPanel.tsx
web/src/components/P9TradingScreen.tsx
~~~

## 3. 本轮独立性

本轮不采信 P9.3.3.2 报告或测试名称本身作为结论，只依据：

1. 当前工作区源码；
2. SQLite schema、索引和触发器；
3. 隔离 SQLite 测试；
4. 独立 Node.js 子进程；
5. 真实命令输出。

新增独立测试文件只做反例验证，不放宽任何既有断言。

## 4. 测试资产

现有 P9.3.3 系列文件共 15 个，其中 14 个为既有专项测试，1 个为本轮独立反例：

- p9-3.3-character-sync.test.ts
- p9-3.3-evidence.test.ts
- p9-3.3-fifo.test.ts
- p9-3.3-wallet-routes.test.ts
- p9-3.3.1-audit-asset-integrity.test.ts
- p9-3.3.1-audit-freshness.test.ts
- p9-3.3.1-audit-wallet-concurrency.test.ts
- p9-3.3.2-asset-integrity.test.ts
- p9-3.3.2-freshness-contract.test.ts
- p9-3.3.2-ledger-evidence-idempotency.test.ts
- p9-3.3.2-wallet-balance-integrity.test.ts
- p9-3.3.2-wallet-cross-connection-lease.test.ts
- p9-3.3.2-wallet-lease-integrity.test.ts
- p9-3.3.2-wallet-multiprocess-lease.test.ts
- p9-3.3.3-asset-race.test.ts

## 5. 限定与边界

- 未连接生产数据库；
- 未执行生产迁移；
- 未调用真实 ESI 钱包/资产接口；
- 未创建或核实真实交易；
- 未提交、推送或部署；
- 未启动 P9.3.4/P9.4。

本报告的“通过”只表示当前源码和隔离数据下通过，不等同于生产环境验证。

## 6. 目标文件要求的 Git 命令实际输出

说明：以下为审计报告收尾复核时重新执行的实际输出。工作区从审计开始到收尾均保持原样，未执行 reset、clean、checkout 或 restore；输出中可能包含本轮新增的审计报告与反例测试。审计开始时的分支、HEAD 与工作区保护结论见上文。

### `git status --short`

~~~text
R  P8_5_1_ASSET_VALUATION_AUDIT.md -> docs/audit/P8.5.1/P8_5_1_ASSET_VALUATION_AUDIT.md
R  P8_5_1_BACKTEST_MODEL_AUDIT.md -> docs/audit/P8.5.1/P8_5_1_BACKTEST_MODEL_AUDIT.md
R  P8_5_1_DATA_RELIABILITY_REPORT.md -> docs/audit/P8.5.1/P8_5_1_DATA_RELIABILITY_REPORT.md
R  P8_5_1_DEPLOYMENT_GUIDE.md -> docs/audit/P8.5.1/P8_5_1_DEPLOYMENT_GUIDE.md
R  P8_5_1_DRAFT_AUDIT_ACCESS_AUDIT.md -> docs/audit/P8.5.1/P8_5_1_DRAFT_AUDIT_ACCESS_AUDIT.md
R  P8_5_1_FINAL_ACCEPTANCE_REPORT.md -> docs/audit/P8.5.1/P8_5_1_FINAL_ACCEPTANCE_REPORT.md
R  P8_5_1_FULL_TEST_REPORT.md -> docs/audit/P8.5.1/P8_5_1_FULL_TEST_REPORT.md
R  P8_5_1_KNOWN_LIMITATIONS.md -> docs/audit/P8.5.1/P8_5_1_KNOWN_LIMITATIONS.md
R  P8_5_1_PAPER_TRADING_ARCHITECTURE.md -> docs/audit/P8.5.1/P8_5_1_PAPER_TRADING_ARCHITECTURE.md
R  P8_5_1_PAPER_TRADING_TEST_REPORT.md -> docs/audit/P8.5.1/P8_5_1_PAPER_TRADING_TEST_REPORT.md
R  P8_5_1_PERFORMANCE_METRICS_AUDIT.md -> docs/audit/P8.5.1/P8_5_1_PERFORMANCE_METRICS_AUDIT.md
R  P8_5_1_READINESS_AUDIT.md -> docs/audit/P8.5.1/P8_5_1_READINESS_AUDIT.md
R  P8_5_2_BACKTEST_AUDIT.md -> docs/audit/P8.5.2/P8_5_2_BACKTEST_AUDIT.md
R  P8_5_2_CODE_AUDIT.md -> docs/audit/P8.5.2/P8_5_2_CODE_AUDIT.md
R  P8_5_2_DATA_RELIABILITY_AUDIT.md -> docs/audit/P8.5.2/P8_5_2_DATA_RELIABILITY_AUDIT.md
R  P8_5_2_FEE_ENGINE_AUDIT.md -> docs/audit/P8.5.2/P8_5_2_FEE_ENGINE_AUDIT.md
R  P8_5_2_FINAL_ACCEPTANCE_REPORT.md -> docs/audit/P8.5.2/P8_5_2_FINAL_ACCEPTANCE_REPORT.md
R  P8_5_2_FULL_TEST_REPORT.md -> docs/audit/P8.5.2/P8_5_2_FULL_TEST_REPORT.md
R  P8_5_2_FUND_AND_ORDER_STATE_AUDIT.md -> docs/audit/P8.5.2/P8_5_2_FUND_AND_ORDER_STATE_AUDIT.md
R  P8_5_2_ORDERBOOK_AUDIT.md -> docs/audit/P8.5.2/P8_5_2_ORDERBOOK_AUDIT.md
R  P8_5_2_PORTFOLIO_AUDIT.md -> docs/audit/P8.5.2/P8_5_2_PORTFOLIO_AUDIT.md
R  P8_5_2_SECURITY_AUDIT.md -> docs/audit/P8.5.2/P8_5_2_SECURITY_AUDIT.md
R  P8_5_2_STRATEGY_AUDIT.md -> docs/audit/P8.5.2/P8_5_2_STRATEGY_AUDIT.md
R  P8_5_2_TRADING_PIPELINE_AUDIT.md -> docs/audit/P8.5.2/P8_5_2_TRADING_PIPELINE_AUDIT.md
R  P8_5_3_BASELINE_AND_FULL_TEST_REPORT.md -> docs/audit/P8.5.3/P8_5_3_BASELINE_AND_FULL_TEST_REPORT.md
R  P8_5_3_DATABASE_RECOVERY_AUDIT.md -> docs/audit/P8.5.3/P8_5_3_DATABASE_RECOVERY_AUDIT.md
R  P8_5_3_DEFECT_REMEDIATION_LOG.md -> docs/audit/P8.5.3/P8_5_3_DEFECT_REMEDIATION_LOG.md
R  P8_5_3_DOUBLE_ENTRY_ACCOUNTING_AUDIT.md -> docs/audit/P8.5.3/P8_5_3_DOUBLE_ENTRY_ACCOUNTING_AUDIT.md
R  P8_5_3_ESI_READONLY_SECURITY_AUDIT.md -> docs/audit/P8.5.3/P8_5_3_ESI_READONLY_SECURITY_AUDIT.md
R  P8_5_3_FINAL_ACCEPTANCE_REPORT.md -> docs/audit/P8.5.3/P8_5_3_FINAL_ACCEPTANCE_REPORT.md
R  P8_5_3_GIT_CHANGE_SUMMARY.md -> docs/audit/P8.5.3/P8_5_3_GIT_CHANGE_SUMMARY.md
R  P8_5_3_IDEMPOTENCY_CONCURRENCY_AUDIT.md -> docs/audit/P8.5.3/P8_5_3_IDEMPOTENCY_CONCURRENCY_AUDIT.md
R  P8_5_3_ORDERBOOK_ADVERSARIAL_AUDIT.md -> docs/audit/P8.5.3/P8_5_3_ORDERBOOK_ADVERSARIAL_AUDIT.md
R  P8_5_3_ORDER_STATE_MACHINE_AUDIT.md -> docs/audit/P8.5.3/P8_5_3_ORDER_STATE_MACHINE_AUDIT.md
R  P8_5_3_PIPELINE_CREDENTIAL_AUDIT.md -> docs/audit/P8.5.3/P8_5_3_PIPELINE_CREDENTIAL_AUDIT.md
R  P8_5_3_REGRESSION_TEST_REPORT.md -> docs/audit/P8.5.3/P8_5_3_REGRESSION_TEST_REPORT.md
R  P8_5_BACKTEST_CAUSALITY_AUDIT.md -> docs/audit/P8.5/P8_5_BACKTEST_CAUSALITY_AUDIT.md
R  P8_5_DRAFT_STATE_SECURITY_AUDIT.md -> docs/audit/P8.5/P8_5_DRAFT_STATE_SECURITY_AUDIT.md
R  P8_5_FEE_ENGINE_AUDIT.md -> docs/audit/P8.5/P8_5_FEE_ENGINE_AUDIT.md
R  P8_5_FINAL_ACCEPTANCE_REPORT.md -> docs/audit/P8.5/P8_5_FINAL_ACCEPTANCE_REPORT.md
R  P8_5_INDEPENDENT_AUDIT.md -> docs/audit/P8.5/P8_5_INDEPENDENT_AUDIT.md
R  P8_5_INTEGRATION_TEST_REPORT.md -> docs/audit/P8.5/P8_5_INTEGRATION_TEST_REPORT.md
R  P8_5_INVENTORY_VALUATION_AUDIT.md -> docs/audit/P8.5/P8_5_INVENTORY_VALUATION_AUDIT.md
R  P8_5_MARKET_TIMESTAMP_AUDIT.md -> docs/audit/P8.5/P8_5_MARKET_TIMESTAMP_AUDIT.md
R  P8_5_ORDERBOOK_LOGIC_AUDIT.md -> docs/audit/P8.5/P8_5_ORDERBOOK_LOGIC_AUDIT.md
R  P8_5_REMEDIATION_LOG.md -> docs/audit/P8.5/P8_5_REMEDIATION_LOG.md
R  P8_BACKTEST_VALIDATION.md -> docs/audit/P8/P8_BACKTEST_VALIDATION.md
R  P8_FEE_ENGINE_VALIDATION.md -> docs/audit/P8/P8_FEE_ENGINE_VALIDATION.md
R  P8_IMPLEMENTATION_REPORT.md -> docs/audit/P8/P8_IMPLEMENTATION_REPORT.md
R  P8_KNOWN_LIMITATIONS.md -> docs/audit/P8/P8_KNOWN_LIMITATIONS.md
R  P8_MARKET_DATA_VALIDATION.md -> docs/audit/P8/P8_MARKET_DATA_VALIDATION.md
R  P8_OPPORTUNITY_RATING.md -> docs/audit/P8/P8_OPPORTUNITY_RATING.md
R  P8_ORDERBOOK_SIMULATION.md -> docs/audit/P8/P8_ORDERBOOK_SIMULATION.md
R  P8_PAPER_TRADING_GUIDE.md -> docs/audit/P8/P8_PAPER_TRADING_GUIDE.md
R  P8_PORTFOLIO_RISK_VALIDATION.md -> docs/audit/P8/P8_PORTFOLIO_RISK_VALIDATION.md
R  P8_REPAIR_PLAN.md -> docs/audit/P8/P8_REPAIR_PLAN.md
R  P8_SECURITY_VALIDATION.md -> docs/audit/P8/P8_SECURITY_VALIDATION.md
R  P8_TEST_REPORT.md -> docs/audit/P8/P8_TEST_REPORT.md
A  docs/audit/README.md
R  BACKTEST_VALIDATION.md -> docs/audit/pre-P8/BACKTEST_VALIDATION.md
R  DATA_SOURCE_AUDIT.md -> docs/audit/pre-P8/DATA_SOURCE_AUDIT.md
R  DEFECT_AND_REMEDIATION_LIST.md -> docs/audit/pre-P8/DEFECT_AND_REMEDIATION_LIST.md
R  DEPLOYMENT_AUDIT.md -> docs/audit/pre-P8/DEPLOYMENT_AUDIT.md
R  DEPLOYMENT_GUIDE.md -> docs/audit/pre-P8/DEPLOYMENT_GUIDE.md
R  EXISTING_CAPABILITIES.md -> docs/audit/pre-P8/EXISTING_CAPABILITIES.md
R  FEE_ENGINE_AUDIT.md -> docs/audit/pre-P8/FEE_ENGINE_AUDIT.md
R  FIRST_TRADE_RECALCULATION.md -> docs/audit/pre-P8/FIRST_TRADE_RECALCULATION.md
R  IMPLEMENTATION_REPORT.md -> docs/audit/pre-P8/IMPLEMENTATION_REPORT.md
R  INSTALLATION_REPORT.md -> docs/audit/pre-P8/INSTALLATION_REPORT.md
R  MARKET_DATA_AUDIT.md -> docs/audit/pre-P8/MARKET_DATA_AUDIT.md
R  PORTFOLIO_RISK_AUDIT.md -> docs/audit/pre-P8/PORTFOLIO_RISK_AUDIT.md
A  docs/audit/pre-P8/README.md
R  SECOND_AUDIT_REPORT.md -> docs/audit/pre-P8/SECOND_AUDIT_REPORT.md
R  SECURITY_AUDIT.md -> docs/audit/pre-P8/SECURITY_AUDIT.md
R  SECURITY_PERMISSION_AUDIT.md -> docs/audit/pre-P8/SECURITY_PERMISSION_AUDIT.md
R  SECURITY_REVIEW.md -> docs/audit/pre-P8/SECURITY_REVIEW.md
R  TRADING_SYSTEM_AUDIT.md -> docs/audit/pre-P8/TRADING_SYSTEM_AUDIT.md
M  docs/exec-plans/active/index.md
R  LOOT_MANAGER_ROADMAP.md -> docs/exec-plans/active/loot-manager-roadmap.md
M  docs/exec-plans/completed/index.md
M  docs/exec-plans/completed/security-hardening-full.md
R  TRADING_IMPLEMENTATION_PLAN.md -> docs/exec-plans/completed/trading-system-implementation.md
A  docs/history/README.md
R  CONFIGURATION_GUIDE.md -> docs/history/legacy-configuration-guide.md
R  MODIFICATION_LOG.md -> docs/history/modification-log.md
M  docs/index.md
M  docs/repo-map.md
R  eveai-threat-model.md -> docs/threat-model.md
A  docs/trading/README.md
R  AI_AGENT_DESIGN.md -> docs/trading/ai-agent-design.md
R  BACKTESTING_GUIDE.md -> docs/trading/backtesting-guide.md
R  FEE_CALCULATION.md -> docs/trading/fee-calculation.md
R  KNOWN_LIMITATIONS.md -> docs/trading/known-limitations.md
R  MARKET_DATA_SOURCES.md -> docs/trading/market-data-sources.md
R  PORTFOLIO_RISK_MODEL.md -> docs/trading/portfolio-risk-model.md
R  TRADING_DATA_DICTIONARY.md -> docs/trading/trading-data-dictionary.md
R  TRADING_STRATEGIES.md -> docs/trading/trading-strategies.md
R  TRADING_SYSTEM_ARCHITECTURE.md -> docs/trading/trading-system-architecture.md
R  TRADING_USER_GUIDE.md -> docs/trading/trading-user-guide.md
 M src/assets/asset-sync-service.ts
 M src/db/migrations.ts
 M src/eve/character-sync.ts
 M src/trading/p9-3-evidence-service.ts
 M src/trading/p9-3-fifo-service.ts
 M src/trading/p9-3-ledger-service.ts
 M src/trading/p9-3-types.ts
 M src/web/p9-3-routes.ts
 M src/web/p9-routes.ts
 M tests/unit/asset-sync.test.ts
 M tests/unit/p9-3-real-accounting.test.ts
 M web/src/components/P93AccountingPanel.tsx
 M web/src/components/P9TradingScreen.tsx
?? docs/audit/P9.3.3.1/
?? docs/audit/P9.3.3.2/
?? docs/audit/P9.3.3.3/
?? docs/audit/P9.3.3/
?? tests/unit/p9-3.3-character-sync.test.ts
?? tests/unit/p9-3.3-evidence.test.ts
?? tests/unit/p9-3.3-fifo.test.ts
?? tests/unit/p9-3.3-wallet-routes.test.ts
?? tests/unit/p9-3.3.1-audit-asset-integrity.test.ts
?? tests/unit/p9-3.3.1-audit-freshness.test.ts
?? tests/unit/p9-3.3.1-audit-wallet-concurrency.test.ts
?? tests/unit/p9-3.3.2-asset-integrity.test.ts
?? tests/unit/p9-3.3.2-freshness-contract.test.ts
?? tests/unit/p9-3.3.2-ledger-evidence-idempotency.test.ts
?? tests/unit/p9-3.3.2-wallet-balance-integrity.test.ts
?? tests/unit/p9-3.3.2-wallet-cross-connection-lease.test.ts
?? tests/unit/p9-3.3.2-wallet-lease-integrity.test.ts
?? tests/unit/p9-3.3.2-wallet-multiprocess-lease.test.ts
?? tests/unit/p9-3.3.3-asset-race.test.ts
?? web/src/p93-freshness.ts
~~~

### `git branch --show-current`

~~~text
deploy/eve-ai-agent
~~~

### `git rev-parse HEAD`

~~~text
9e8e8b32d0e065c6d8479140f94662087193279d
~~~

### `git log -8 --oneline --decorate`

~~~text
9e8e8b3 (HEAD -> deploy/eve-ai-agent, origin/deploy/eve-ai-agent) fix(ci): remove prohibited artifacts and correct expiry gate
2f11d3a feat(audit): complete project quality and P9.3 financial verification
7e65027 docs(p9.3.2): record production deployment and version verification
66ec798 feat(p9.3): deliver real accounting ledger and P9.3.1 hardening
6d78d59 feat(p9.2): add real asset inventory and valuation workbench
21f509e fix(p9.1.1): stabilize WSL-hosted service and correct opportunity status semantics
89954d4 feat(p9.1): deliver real ESI market opportunity center
b021fc8 feat(p8.7): validate paper trading fills, performance and runtime integrity
~~~

### `git diff --stat`

~~~text
 src/assets/asset-sync-service.ts          |  49 +-
 src/db/migrations.ts                      |  26 +
 src/eve/character-sync.ts                 |  72 ++-
 src/trading/p9-3-evidence-service.ts      | 879 ++++++++++++++++++++++++++----
 src/trading/p9-3-fifo-service.ts          | 129 ++++-
 src/trading/p9-3-ledger-service.ts        |  95 +++-
 src/trading/p9-3-types.ts                 |  17 +-
 src/web/p9-3-routes.ts                    |  15 +
 src/web/p9-routes.ts                      |   6 +
 tests/unit/asset-sync.test.ts             |   4 +-
 tests/unit/p9-3-real-accounting.test.ts   |   4 +-
 web/src/components/P93AccountingPanel.tsx |  34 +-
 web/src/components/P9TradingScreen.tsx    |  32 +-
 13 files changed, 1180 insertions(+), 182 deletions(-)
~~~

### `git diff --name-only`

~~~text
src/assets/asset-sync-service.ts
src/db/migrations.ts
src/eve/character-sync.ts
src/trading/p9-3-evidence-service.ts
src/trading/p9-3-fifo-service.ts
src/trading/p9-3-ledger-service.ts
src/trading/p9-3-types.ts
src/web/p9-3-routes.ts
src/web/p9-routes.ts
tests/unit/asset-sync.test.ts
tests/unit/p9-3-real-accounting.test.ts
web/src/components/P93AccountingPanel.tsx
web/src/components/P9TradingScreen.tsx
~~~

### `git diff --cached --stat`

~~~text
 .../audit/P8.5.1/P8_5_1_ASSET_VALUATION_AUDIT.md   |  0
 .../audit/P8.5.1/P8_5_1_BACKTEST_MODEL_AUDIT.md    |  0
 .../audit/P8.5.1/P8_5_1_DATA_RELIABILITY_REPORT.md |  0
 .../audit/P8.5.1/P8_5_1_DEPLOYMENT_GUIDE.md        |  0
 .../P8.5.1/P8_5_1_DRAFT_AUDIT_ACCESS_AUDIT.md      |  0
 .../audit/P8.5.1/P8_5_1_FINAL_ACCEPTANCE_REPORT.md |  0
 .../audit/P8.5.1/P8_5_1_FULL_TEST_REPORT.md        |  0
 .../audit/P8.5.1/P8_5_1_KNOWN_LIMITATIONS.md       |  0
 .../P8.5.1/P8_5_1_PAPER_TRADING_ARCHITECTURE.md    |  0
 .../P8.5.1/P8_5_1_PAPER_TRADING_TEST_REPORT.md     |  0
 .../P8.5.1/P8_5_1_PERFORMANCE_METRICS_AUDIT.md     |  0
 .../audit/P8.5.1/P8_5_1_READINESS_AUDIT.md         |  0
 .../audit/P8.5.2/P8_5_2_BACKTEST_AUDIT.md          |  0
 .../audit/P8.5.2/P8_5_2_CODE_AUDIT.md              |  0
 .../audit/P8.5.2/P8_5_2_DATA_RELIABILITY_AUDIT.md  |  0
 .../audit/P8.5.2/P8_5_2_FEE_ENGINE_AUDIT.md        |  0
 .../audit/P8.5.2/P8_5_2_FINAL_ACCEPTANCE_REPORT.md |  0
 .../audit/P8.5.2/P8_5_2_FULL_TEST_REPORT.md        |  0
 .../P8.5.2/P8_5_2_FUND_AND_ORDER_STATE_AUDIT.md    |  0
 .../audit/P8.5.2/P8_5_2_ORDERBOOK_AUDIT.md         |  0
 .../audit/P8.5.2/P8_5_2_PORTFOLIO_AUDIT.md         |  0
 .../audit/P8.5.2/P8_5_2_SECURITY_AUDIT.md          |  0
 .../audit/P8.5.2/P8_5_2_STRATEGY_AUDIT.md          |  0
 .../audit/P8.5.2/P8_5_2_TRADING_PIPELINE_AUDIT.md  |  0
 .../P8.5.3/P8_5_3_BASELINE_AND_FULL_TEST_REPORT.md |  0
 .../audit/P8.5.3/P8_5_3_DATABASE_RECOVERY_AUDIT.md |  0
 .../audit/P8.5.3/P8_5_3_DEFECT_REMEDIATION_LOG.md  |  0
 .../P8.5.3/P8_5_3_DOUBLE_ENTRY_ACCOUNTING_AUDIT.md |  0
 .../P8.5.3/P8_5_3_ESI_READONLY_SECURITY_AUDIT.md   |  0
 .../audit/P8.5.3/P8_5_3_FINAL_ACCEPTANCE_REPORT.md |  0
 .../audit/P8.5.3/P8_5_3_GIT_CHANGE_SUMMARY.md      |  0
 .../P8.5.3/P8_5_3_IDEMPOTENCY_CONCURRENCY_AUDIT.md |  0
 .../P8.5.3/P8_5_3_ORDERBOOK_ADVERSARIAL_AUDIT.md   |  0
 .../P8.5.3/P8_5_3_ORDER_STATE_MACHINE_AUDIT.md     |  0
 .../P8.5.3/P8_5_3_PIPELINE_CREDENTIAL_AUDIT.md     |  0
 .../audit/P8.5.3/P8_5_3_REGRESSION_TEST_REPORT.md  |  0
 .../audit/P8.5/P8_5_BACKTEST_CAUSALITY_AUDIT.md    |  0
 .../audit/P8.5/P8_5_DRAFT_STATE_SECURITY_AUDIT.md  |  0
 .../audit/P8.5/P8_5_FEE_ENGINE_AUDIT.md            |  0
 .../audit/P8.5/P8_5_FINAL_ACCEPTANCE_REPORT.md     |  0
 .../audit/P8.5/P8_5_INDEPENDENT_AUDIT.md           |  0
 .../audit/P8.5/P8_5_INTEGRATION_TEST_REPORT.md     |  0
 .../audit/P8.5/P8_5_INVENTORY_VALUATION_AUDIT.md   |  0
 .../audit/P8.5/P8_5_MARKET_TIMESTAMP_AUDIT.md      |  0
 .../audit/P8.5/P8_5_ORDERBOOK_LOGIC_AUDIT.md       |  0
 .../audit/P8.5/P8_5_REMEDIATION_LOG.md             |  0
 .../audit/P8/P8_BACKTEST_VALIDATION.md             |  0
 .../audit/P8/P8_FEE_ENGINE_VALIDATION.md           |  0
 .../audit/P8/P8_IMPLEMENTATION_REPORT.md           |  0
 .../audit/P8/P8_KNOWN_LIMITATIONS.md               |  0
 .../audit/P8/P8_MARKET_DATA_VALIDATION.md          |  0
 .../audit/P8/P8_OPPORTUNITY_RATING.md              |  0
 .../audit/P8/P8_ORDERBOOK_SIMULATION.md            |  0
 .../audit/P8/P8_PAPER_TRADING_GUIDE.md             |  0
 .../audit/P8/P8_PORTFOLIO_RISK_VALIDATION.md       |  0
 .../audit/P8/P8_REPAIR_PLAN.md                     |  0
 .../audit/P8/P8_SECURITY_VALIDATION.md             |  0
 .../audit/P8/P8_TEST_REPORT.md                     |  0
 docs/audit/README.md                               | 38 ++++++++++++++
 .../audit/pre-P8/BACKTEST_VALIDATION.md            |  0
 .../audit/pre-P8/DATA_SOURCE_AUDIT.md              |  0
 .../audit/pre-P8/DEFECT_AND_REMEDIATION_LIST.md    |  0
 .../audit/pre-P8/DEPLOYMENT_AUDIT.md               |  0
 .../audit/pre-P8/DEPLOYMENT_GUIDE.md               |  0
 .../audit/pre-P8/EXISTING_CAPABILITIES.md          |  0
 .../audit/pre-P8/FEE_ENGINE_AUDIT.md               |  0
 .../audit/pre-P8/FIRST_TRADE_RECALCULATION.md      |  0
 .../audit/pre-P8/IMPLEMENTATION_REPORT.md          |  0
 .../audit/pre-P8/INSTALLATION_REPORT.md            |  0
 .../audit/pre-P8/MARKET_DATA_AUDIT.md              |  0
 .../audit/pre-P8/PORTFOLIO_RISK_AUDIT.md           |  0
 docs/audit/pre-P8/README.md                        | 42 ++++++++++++++++
 .../audit/pre-P8/SECOND_AUDIT_REPORT.md            |  0
 .../audit/pre-P8/SECURITY_AUDIT.md                 |  0
 .../audit/pre-P8/SECURITY_PERMISSION_AUDIT.md      |  0
 .../audit/pre-P8/SECURITY_REVIEW.md                |  0
 .../audit/pre-P8/TRADING_SYSTEM_AUDIT.md           |  0
 docs/exec-plans/active/index.md                    |  1 +
 .../exec-plans/active/loot-manager-roadmap.md      |  0
 docs/exec-plans/completed/index.md                 |  1 +
 .../completed/security-hardening-full.md           |  2 +-
 .../completed/trading-system-implementation.md     |  8 +--
 docs/history/README.md                             | 12 +++++
 .../history/legacy-configuration-guide.md          |  0
 .../history/modification-log.md                    | 58 ++++++++++++++++------
 docs/index.md                                      |  7 +++
 docs/repo-map.md                                   |  5 ++
 eveai-threat-model.md => docs/threat-model.md      |  2 +-
 docs/trading/README.md                             | 29 +++++++++++
 .../trading/ai-agent-design.md                     |  0
 .../trading/backtesting-guide.md                   |  0
 .../trading/fee-calculation.md                     |  0
 .../trading/known-limitations.md                   |  0
 .../trading/market-data-sources.md                 |  0
 .../trading/portfolio-risk-model.md                |  0
 .../trading/trading-data-dictionary.md             |  0
 .../trading/trading-strategies.md                  |  0
 .../trading/trading-system-architecture.md         |  0
 .../trading/trading-user-guide.md                  |  0
 99 files changed, 185 insertions(+), 20 deletions(-)
~~~

### `git ls-files --others --exclude-standard`

~~~text
docs/audit/P9.3.3.1/01-identity-and-concurrency.md
docs/audit/P9.3.3.1/02-wallet-cursor.md
docs/audit/P9.3.3.1/03-fifo-and-pnl.md
docs/audit/P9.3.3.1/04-asset-and-wallet-integrity.md
docs/audit/P9.3.3.1/05-database-and-ledger.md
docs/audit/P9.3.3.1/06-agent-and-permissions.md
docs/audit/P9.3.3.1/07-test-coverage.md
docs/audit/P9.3.3.1/08-findings-and-recommendations.md
docs/audit/P9.3.3.1/README.md
docs/audit/P9.3.3.2/01-F01-asset-validation.md
docs/audit/P9.3.3.2/02-F02-wallet-concurrency.md
docs/audit/P9.3.3.2/03-F03-cursor-monotonicity.md
docs/audit/P9.3.3.2/04-F04-identity-atomicity.md
docs/audit/P9.3.3.2/05-F05-evidence-idempotency.md
docs/audit/P9.3.3.2/06-F06-freshness-contract.md
docs/audit/P9.3.3.2/07-F07-wallet-balance.md
docs/audit/P9.3.3.2/08-tests-and-quality-gates.md
docs/audit/P9.3.3.2/09-security-regression.md
docs/audit/P9.3.3.2/10-unresolved-risks.md
docs/audit/P9.3.3.2/README.md
docs/audit/P9.3.3.3/01-audit-baseline.md
docs/audit/P9.3.3.3/02-sqlite-lease-and-fencing.md
docs/audit/P9.3.3.3/03-wallet-cursor-and-failure-queue.md
docs/audit/P9.3.3.3/04-asset-snapshot-integrity.md
docs/audit/P9.3.3.3/05-identity-and-oauth.md
docs/audit/P9.3.3.3/06-fifo-and-freshness.md
docs/audit/P9.3.3.3/07-evidence-idempotency.md
docs/audit/P9.3.3.3/08-real-paper-and-esi-security.md
docs/audit/P9.3.3.3/09-fault-injection-and-recovery.md
docs/audit/P9.3.3.3/10-tests-and-quality-gates.md
docs/audit/P9.3.3.3/11-production-validation-boundaries.md
docs/audit/P9.3.3.3/12-findings-and-recommendations.md
docs/audit/P9.3.3.3/README.md
docs/audit/P9.3.3/01-wallet-sync-and-identity.md
docs/audit/P9.3.3/02-incremental-cursor-integrity.md
docs/audit/P9.3.3/03-fifo-pnl-semantics.md
docs/audit/P9.3.3/04-profile-sync-data-integrity.md
docs/audit/P9.3.3/05-tests-and-quality-gates.md
docs/audit/P9.3.3/06-security-boundaries.md
docs/audit/P9.3.3/07-unresolved-risks.md
docs/audit/P9.3.3/README.md
tests/unit/p9-3.3-character-sync.test.ts
tests/unit/p9-3.3-evidence.test.ts
tests/unit/p9-3.3-fifo.test.ts
tests/unit/p9-3.3-wallet-routes.test.ts
tests/unit/p9-3.3.1-audit-asset-integrity.test.ts
tests/unit/p9-3.3.1-audit-freshness.test.ts
tests/unit/p9-3.3.1-audit-wallet-concurrency.test.ts
tests/unit/p9-3.3.2-asset-integrity.test.ts
tests/unit/p9-3.3.2-freshness-contract.test.ts
tests/unit/p9-3.3.2-ledger-evidence-idempotency.test.ts
tests/unit/p9-3.3.2-wallet-balance-integrity.test.ts
tests/unit/p9-3.3.2-wallet-cross-connection-lease.test.ts
tests/unit/p9-3.3.2-wallet-lease-integrity.test.ts
tests/unit/p9-3.3.2-wallet-multiprocess-lease.test.ts
tests/unit/p9-3.3.3-asset-race.test.ts
web/src/p93-freshness.ts
~~~
