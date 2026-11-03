# P9.3 测试及真实环境验证报告

## 自动测试

执行：

```text
npx vitest run tests/unit/p9-3-real-accounting.test.ts
```

结果：7/7 通过，覆盖：

- 人工登记默认不核实、证据核实门禁。
- 幂等重复登记。
- 多买入一次卖出 FIFO 与费用。
- 一次买入多次卖出/部分成交。
- UNKNOWN 成本、库存不足和 UNKNOWN_SOURCE。
- 冲正、更正、审计事件、不可变触发器。
- REAL/PAPER 隔离和 AI actor 阻断。
- 资产快照对账 MATCHED/UNKNOWN_SOURCE，且资产变化不生成交易。

回归执行：

```text
npm run typecheck
npm run web:check
npm run lint
npx vitest run tests/unit/p9-3-real-accounting.test.ts tests/unit/asset-valuation.test.ts tests/unit/asset-inventory.test.ts tests/unit/asset-history.test.ts
```

结果：通过。

完整 `npm run check` 在本阶段前后两次运行均因既有 `tests/integration/perimeter-radar.test.ts` 的时间敏感集成用例失败而中止：一次表现为 intel 事件数量少 1，随后 afterEach 超时；最终复跑表现为 pursuit advisory 未按预期出现，随后 afterEach 超时。该文件未被本阶段修改，且定向回归均通过；不能把完整套件报告为全绿。

## 真实环境

- 已对真实本地数据库 `data/eve-agent.db` 执行迁移前备份：`data/backups/eve-agent.db.bak_20261103_p93_pre`。
- 已执行 P9.3 数据库迁移。
- 已执行备份/恢复验证脚本：`npx tsx scripts/p9-backup-verify.ts --db=data/eve-agent.db --out=data/backups`，结果 `ok: true`，SQLite integrity_check 通过，恢复文件中 `real_trade_records=0`、`real_trade_events=0`（当前没有真实交易样本）。
- 尚未在本次执行中取得并披露真实 ESI 资产同步、钱包日志同步、订单关联和人工核实样本；因此不声称真实交易绩效或真实 FIFO 已验证。

## 已知限制

1. ESI wallet transactions 不含完整经纪人费用/税费；同步记录费用完整性为 UNKNOWN，必须结合钱包日志/人工证据补充。
2. 没有真实成交样本时，真实盈亏只能显示 N/A 或测试数据结果。
3. 完整 `npm run check` 受既有 perimeter 集成测试的时间敏感失败影响。
4. 真实资产快照、钱包日志、订单关联、人工核实流程、完整盈亏重算需要在有真实角色和权限的环境中继续验证。