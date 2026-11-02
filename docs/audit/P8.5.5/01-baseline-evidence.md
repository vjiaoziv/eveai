# P8.5.5 基线与 Git 证据

日期：2026-11-02（Asia/Shanghai）

## 实际工作区

- 实际源码仓库：/home/ubuntu/projects/eveai
- 分支：deploy/eve-ai-agent
- HEAD：c7e3fa74663303624c63193016555dcd8accb20a
- HEAD 提交：feat(p8.5.4): harden cryptographic pipeline verification credential, enforce anti-replay and deliver 12 audit reports in docs/audit/P8.5.4/

D:\Git\EVE 是 Windows 报告镜像目录，不是源码 Git 仓库；Windows 侧 master 分支没有提交。审计以 WSL 仓库为准。

## 基线冻结命令与结果

执行：

~~~text
git status --short
git branch --show-current
git rev-parse HEAD
git log -5 --oneline
git show --stat c7e3fa7
~~~

关键结果：

~~~text
 M scripts/eve-cli.ts
 M src/agent/prompts.ts
 M src/agent/tools/sde-schema.ts
?? tests/unit/p8-5-5-a01-a24.test.ts
deploy/eve-ai-agent
c7e3fa74663303624c63193016555dcd8accb20a
~~~

审计开始时工作区包含 P8.5.5 测试和修复，因此不是干净基线；审计完成后已提交为 the current P8.5.5 HEAD (resolve with git rev-parse HEAD)。没有执行 reset、checkout 覆盖或清理用户已有修改。

## P8.5.4 交付核验

docs/audit/P8.5.4/ 存在 12 份报告：

~~~text
01-baseline-and-git-audit.md
02-credential-cryptography-audit.md
03-credential-replay-and-concurrency.md
04-market-snapshot-integrity.md
05-accounting-model-audit.md
06-fee-model-audit.md
07-ledger-reconciliation.md
08-esi-readonly-security-audit.md
09-adversarial-test-report.md
10-full-regression-report.md
11-risk-register.md
12-p8-5-4-final-verdict.md
~~~

## 本次审计期间的关键状态变化

- 新增 tests/unit/p8-5-5-a01-a24.test.ts。
- 新增 tests/unit/p8-5-5-crypto-atomicity.test.ts。
- 新增 tests/unit/p8-5-5-independent-ledger.test.ts。
- 新增 tests/unit/p8-5-5-esi-runtime-guard.test.ts。
- 将管线凭证规范化从管道符拼接改为版本化 JSON。
- 将签名密钥从源码硬编码改为 EVEAI_PIPELINE_SIGNING_KEYS 环境变量。
- 为凭证增加 opportunityId、marketSnapshotHash 和 expectedNetProfit 一致性校验。
- 将凭证消费与草案写入放入同一 SQLite 事务。
- 将成交费用拆分为 order_spend / order_revenue 与 fee_payment 分录。
- 增加 paper_trading_orders.escrow_locked 与 fee_reserved，精确释放部分成交后剩余担保金。
- 修复 map-route-clear.test.ts 对未知目的地请求的超时。

## 结论

基线是 c7e3fa7，P8.5.5 审计与修复最终提交为 the P8.5.5 commit。最终报告必须区分 P8.5.4 基线和 P8.5.5 提交，不能把工作区变更误报为 c7e3fa7 原提交内容。
