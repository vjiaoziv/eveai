# EVEAI P8.5.3：全套回归测试与专项用例汇总报告 (P8_5_3_REGRESSION_TEST_REPORT.md)

**完成日期**: 2026-11-02  
**执行命令**: `npx vitest run tests/unit/trading-fee-simulator.test.ts tests/unit/trading-system-full.test.ts tests/unit/trading-pipeline.test.ts tests/unit/p8-5-integration.test.ts tests/unit/p8-5-1-paper-trading.test.ts tests/unit/p8-5-2-stress.test.ts tests/unit/p8-5-3-adversarial.test.ts`

---

## 一、7 套专项测试矩阵 (42 项用例 100% 通过)

```text
 ✓ tests/unit/trading-fee-simulator.test.ts (10 tests, 18ms)
 ✓ tests/unit/trading-pipeline.test.ts (2 tests, 121ms)
 ✓ tests/unit/p8-5-3-adversarial.test.ts (5 tests, 197ms)
 ✓ tests/unit/p8-5-integration.test.ts (6 tests, 225ms)
 ✓ tests/unit/p8-5-1-paper-trading.test.ts (6 tests, 238ms)
 ✓ tests/unit/trading-system-full.test.ts (5 tests, 258ms)
 ✓ tests/unit/p8-5-2-stress.test.ts (8 tests, 368ms)

Test Files  7 passed (7/7)
     Tests  42 passed (42/42, 100% 通过率)
  Duration  1.34s
```

---

## 二、测试分类汇总

1. **数值精算测试 (10项)**: 销售税基准 7.5%、Accounting 0~5、Broker Relations 0~5、100 ISK 保底、Upwell SCC 税。
2. **决策管线与防虚假价差测试 (4项)**: 订单簿深度截断、多档位边际优化、两地数据时差一票否决。
3. **风控凭证与对抗测试 (5项)**: 缺失凭证拦截、参数篡改拦截、凭证过期拦截、数字签名验伪。
4. **资金风控与资产负债表测试 (11项)**: 现金储备、在途草案锁定、单品/品类限额、双重记账流水对账、部分成交与撤单。
5. **订单状态机与幂等测试 (6项)**: 终结态不可逆、幂等同参防重、幂等异参冲突拦截。
6. **安全权限测试 (6项)**: 撤销草案全入口物理锁死、代码库 0 写入工具静态断言。
