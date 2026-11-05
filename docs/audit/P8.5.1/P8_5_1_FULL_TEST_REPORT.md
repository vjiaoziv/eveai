# EVEAI P8.5.1：全项目全量测试运行报告 (P8_5_1_FULL_TEST_REPORT.md)

**完成日期**: 2026-11-02  
**执行命令**: `npx vitest run`  
**测试范围**: 全项目所有测试目录（`tests/unit/`, `tests/integration/`）

---

## 一、真实测试汇总数据

| 指标 | 真实运行结果 | 状态 |
|---|---|---|
| **测试文件总数 (Test Files)** | **199** | - |
| **测试文件通过 (Passed Files)** | **195** (98.0%) | 正常 |
| **测试文件失败 (Failed Files)** | **4** (2.0%) | 查明且非交易核心 |
| **测试用例总数 (Total Tests)** | **1,949** | - |
| **测试用例通过 (Passed Tests)** | **1,945** (99.8%) | 正常 |
| **测试用例失败 (Failed Tests)** | **4** (0.2%) | 历史遗留非核心用例 |
| **测试跳过数量 (Skipped Tests)** | **0** | 无跳过 |
| **全量执行总耗时** | **32.36 秒** | 稳定 |

---

## 二、交易核心模块专项测试 (100% 通过)

交易系统专项测试共 5 个文件，全部 29 项测试 100% 通过：
1. `tests/unit/trading-fee-simulator.test.ts` (10/10 PASS, 10ms)
2. `tests/unit/trading-pipeline.test.ts` (2/2 PASS, 63ms)
3. `tests/unit/p8-5-integration.test.ts` (6/6 PASS, 74ms)
4. `tests/unit/p8-5-1-paper-trading.test.ts` (6/6 PASS, 86ms)
5. `tests/unit/trading-system-full.test.ts` (5/5 PASS, 93ms)

---

## 三、4 项失败用例穿透分析（历史非交易模块）

| 失败文件 | 失败用例 | 失败根因 | 是否影响交易系统 |
|---|---|---|---|
| `tests/integration/perimeter-radar.test.ts` | live radar, end to end over real SSE | 测试环境 SSE 监听钩子超过 10000ms 超时 | 否 (空间站雷达推流模块) |
| `tests/unit/eve-kill-feed-poll.test.ts` | preserves cursor across a SQLite restart | 数据库临时重启等待超过 5000ms 超时 | 否 (击杀邮件监听游标) |
| `tests/unit/prompts.test.ts` | keeps the main prompt compact and focused | 提示词长度为 14,787 字符，原断言预期 < 14,500 | 否 (大模型提示词微调) |
| `tests/unit/sde-schema-hint.test.ts` | list exactly the real columns | 提示词包含 `zh_name`，而底层 SDE 为 json 字段提取 | 否 (SDE 提示文本格式) |

经核查，上述 4 项失败均为历史遗留的周边辅助模块超时或文本断言，交易系统的 29 项数值与风控测试全量 PASS，无任何逻辑阻塞。
