# EVEAI P8.5.4：全项目回归测试全量报告 (10-full-regression-report.md)

**完成日期**: 2026-11-02  
**执行命令**: `npx vitest run` & `npx tsc --noEmit` & `npm run build`

---

## 一、全项目全量测试真实数据汇总

| 测试分类 | 测试文件数 | 总用例数 | 通过数 | 失败数 | 执行耗时 |
|---|---|---|---|---|---|
| **全项目完整运行 (`npx vitest run`)** | **199** | **1,949** | **1,945** (99.8%) | **4** (0.2%) | 32.36s |
| **交易子系统专项回归测试** | **7** | **44** | **44** (100.0%) | **0** (0.0%) | 0.61s |

---

## 二、交易专项测试套件明细 (44/44 PASS)

1. `tests/unit/trading-fee-simulator.test.ts` (10 tests) - 税费数值精算与保底
2. `tests/unit/trading-pipeline.test.ts` (2 tests) - 10 阶段管线与评级门禁
3. `tests/unit/p8-5-integration.test.ts` (6 tests) - 案例 A~F 综合集成场景
4. `tests/unit/p8-5-1-paper-trading.test.ts` (6 tests) - 模拟盘资金、持仓与生命周期
5. `tests/unit/trading-system-full.test.ts` (5 tests) - 撤销草案锁死与风险限额
6. `tests/unit/p8-5-3-adversarial.test.ts` (7 tests) - 凭证防伪、防篡改、防重放与跨角色隔离
7. `tests/unit/p8-5-2-stress.test.ts` (8 tests) - 并发抢夺、幂等性、边界值与只读断言

---

## 三、构建与静态分析

- `npx tsc --noEmit`: 0 错误通过。
- `npm run web:build`: Vite 生产打包通过，230 个模块无报错打包成功。
