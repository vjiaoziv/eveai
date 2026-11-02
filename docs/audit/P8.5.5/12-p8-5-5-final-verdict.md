# P8.5.5 最终验收裁定

## 1. 基线 Commit 和工作区状态

- P8.5.4 基线 Commit：c7e3fa74663303624c63193016555dcd8accb20a。
- P8.5.5 最终 Commit：the current P8.5.5 HEAD (resolve with git rev-parse HEAD)。
- 分支：deploy/eve-ai-agent。
- 工作区：提交完成后干净。

## 2. 问题数量

- P0：0 个未处理资产写漏洞；1 个历史签名密钥泄露风险必须按部署环境处置。
- P1：5 个未解决风险，详见 11-full-regression-and-risk-register.md。
- P2：4 个改进项。

## 3. 实际修复

- 管线凭证规范化改为版本化 JSON，修复分隔符和精度歧义。
- opportunityId、marketSnapshotHash、expectedNetProfit 纳入绑定校验。
- 签名密钥改为环境变量，移除工作树硬编码。
- 凭证消费和草案创建改为同一事务。
- journal 拆分费用分录，支持逐笔重算。
- 订单担保金按 escrow_locked 精确释放。
- 修复 map-route-clear.test.ts 未知目的地超时。
- 修复 lint warnings。

## 4. 凭证安全审计

关键绑定、签名校验、角色隔离、参数一致性、D 级否决和 15 分钟时效均已验证。独立 snapshotId、精确买卖快照时间戳、feeModelVersion 尚未绑定。

## 5. HMAC 密钥轮换

A16 实测通过：注册 v2、签发验证、注销 v2、旧凭证失效。Git 历史旧密钥视为泄露。

## 6. 防重放与并发事务

A13、A14、A17、A18、A22 通过。新增强制草案插入失败的事务回滚测试，消费记录和草案均回滚。真实高并发数据库竞争仍有限。

## 7. 行情快照

内容 SHA-256、过期拒绝、替换拒绝通过。快照 ID、精确时间戳和完整订单簿覆盖不足，结论 PARTIAL。

## 8. 独立复式记账

独立 replay 不调用 verifyAccountBalance，逐条重建 cash/escrow。测试场景最终差异 0.00 ISK。历史订单迁移仍是缺口。

## 9. 费用重复扣除

A20 证明 Upwell broker fee 与 SCC 独立，无重复扣费。A21 证明 100 ISK 保底按代码生效；官方来源未充分证明 100 ISK 绝对值。

## 10. A01-A24

24/24 全部存在真实测试并运行通过；另 4 项 P8.5.5 补充测试通过。A23 仅是资产写表面静态证据。

## 11. ESI 运行时只读安全

未知 operation 在网络派发前阻断。没有资产写路径，但 UI POST 可达，因此严格只读 HTTP 边界未完全证明。

## 12. 全项目测试

- 1995/1998 通过。
- 3 项失败，均集中在并行运行下的 perimeter/kill-feed 超时。
- typecheck、build、lint 通过。

## 13. 尚未解决风险

严格 ESI 只读边界、并行回归 flaky、feeModelVersion、独立快照 ID/时间戳、100 ISK 官方依据、历史担保金迁移。

## 14. 最终验收状态

PAPER_TRADING_BLOCKED

理由：核心机制已显著加固，但最终规则要求 ESI 运行时只读安全得到验证、全项目测试真实完整、P1 风险清零。当前仍有 UI POST 可达、3 项全量回归失败和多个 P1 证据缺口。不得维持 P8.5.4 的 PAPER_TRADING_READY 结论，更不能输出 REAL_TRADING_READY。

## 15. Git Commit ID

P8.5.5 最终提交：the current P8.5.5 HEAD (resolve with git rev-parse HEAD)

P8.5.4 基线仍为 c7e3fa74663303624c63193016555dcd8accb20a。

## 16. 12 份审计文档路径

~~~text
/home/ubuntu/projects/eveai/docs/audit/P8.5.5/01-baseline-evidence.md
/home/ubuntu/projects/eveai/docs/audit/P8.5.5/02-credential-flow-audit.md
/home/ubuntu/projects/eveai/docs/audit/P8.5.5/03-hmac-canonicalization-audit.md
/home/ubuntu/projects/eveai/docs/audit/P8.5.5/04-key-management-and-rotation.md
/home/ubuntu/projects/eveai/docs/audit/P8.5.5/05-replay-and-transaction-audit.md
/home/ubuntu/projects/eveai/docs/audit/P8.5.5/06-market-snapshot-independent-audit.md
/home/ubuntu/projects/eveai/docs/audit/P8.5.5/07-double-entry-independent-reconciliation.md
/home/ubuntu/projects/eveai/docs/audit/P8.5.5/08-fee-model-independent-audit.md
/home/ubuntu/projects/eveai/docs/audit/P8.5.5/09-a01-a24-test-evidence-matrix.md
/home/ubuntu/projects/eveai/docs/audit/P8.5.5/10-runtime-esi-readonly-audit.md
/home/ubuntu/projects/eveai/docs/audit/P8.5.5/11-full-regression-and-risk-register.md
/home/ubuntu/projects/eveai/docs/audit/P8.5.5/12-p8-5-5-final-verdict.md
~~~

## 最终强调

本阶段尝试推翻 P8.5.4 的安全结论。结果是：不能维持 PAPER_TRADING_READY。虽然多项核心缺陷已修复并有证据，但严格只读边界和完整回归仍不满足最终验收规则，故正式裁定 PAPER_TRADING_BLOCKED。
