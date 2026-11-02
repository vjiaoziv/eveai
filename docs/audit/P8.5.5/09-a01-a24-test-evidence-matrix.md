# P8.5.5 A01-A24 测试证据矩阵

统一执行命令：

~~~text
npx vitest run tests/unit/p8-5-5-a01-a24.test.ts tests/unit/p8-5-5-crypto-atomicity.test.ts tests/unit/p8-5-5-independent-ledger.test.ts
~~~

执行结果：3 个测试文件、28 项测试全部通过。A01-A24 为 24/24 通过。

测试文件：tests/unit/p8-5-5-a01-a24.test.ts。

| 场景 | 测试名称与行号 | 实际断言 | 结果 |
|---|---|---|---|
| A01 | L103 无凭证创建草案 | createDraft 抛出【凭证缺失】 | PASS |
| A02 | L110 伪造签名 | 抛出【凭证篡改】 | PASS |
| A03 | L117 修改价格 | 抛出【参数篡改】 | PASS |
| A04 | L124 修改数量 | 抛出【参数篡改】 | PASS |
| A05 | L131 修改 Type ID | 抛出【参数篡改】 | PASS |
| A06 | L138 修改站点 | 抛出【参数篡改】 | PASS |
| A07 | L145 跨角色复用 | 抛出【跨角色越权】 | PASS |
| A08 | L152 跨机会复用 | 机会 ID 或参数不一致被拒绝 | PASS |
| A09 | L162 跨策略复用 | 抛出【参数篡改】 | PASS |
| A10 | L169 过期凭证 | 抛出【凭证过期】 | PASS |
| A11 | L179 快照替换 | 抛出【行情快照不一致】 | PASS |
| A12 | L191 快照过期 | 评级 D、不可执行、无草案 | PASS |
| A13 | L217 凭证重放 | 第二次抛出【凭证重放阻断】 | PASS |
| A14 | L229 幂等异参 | 返回【幂等冲突】 | PASS |
| A15 | L258 密钥缺失 | 未知 keyId 签名和验证均安全失败 | PASS |
| A16 | L291 密钥轮换 | 删除 v2 后旧凭证【密钥失效】 | PASS |
| A17 | L308 重复成交事件 | 重复提交不重复记账 | PASS |
| A18 | L335 成交后撤单 | 已成交订单 cancel 返回 false | PASS |
| A19 | L353 部分成交撤单 | 剩余担保金精确释放，差异 0 | PASS |
| A20 | L377 SCC 重复扣费 | broker fee 与 SCC 税独立且合计正确 | PASS |
| A21 | L400 费用舍入 | 100 ISK 保底按代码模型生效 | PASS |
| A22 | L421 资金守恒 | 50 个订单后现金不透支 | PASS |
| A23 | L441 ESI 写暴露 | agent tools 文件不含 create/cancel market order、wallet transfer | PASS for asset-write surface only |
| A24 | L449 崩溃恢复 | 重建后借贷平衡，差异 0 | PASS |

补充测试：

- tests/unit/p8-5-5-crypto-atomicity.test.ts:68 规范化边界。
- tests/unit/p8-5-5-crypto-atomicity.test.ts:85 expectedNetProfit 和快照篡改。
- tests/unit/p8-5-5-crypto-atomicity.test.ts:99 草案写失败时凭证消费回滚。
- tests/unit/p8-5-5-independent-ledger.test.ts:69 逐笔 journal 独立重算。
- tests/unit/p8-5-5-esi-runtime-guard.test.ts:8 未知 ESI 操作在网络派发前 404 阻断。

## 证据边界

- A23 仅证明 Agent 工具表面没有资产市场写工具；它不能证明所有 HTTP 层都只读。UI POST 的运行时问题见 10-runtime-esi-readonly-audit.md。
- A22 是同步压力，不是真实并行数据库竞争。
- A16 证明动态 keyId 注销，不证明 KMS/HSM 级密钥管理。
