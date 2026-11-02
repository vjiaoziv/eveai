# EVEAI P8.5.2：交易管线与风控穿透审计报告 (P8_5_2_TRADING_PIPELINE_AUDIT.md)

**完成日期**: 2026-11-02  
**关联代码**: `src/trading/trading-pipeline.ts`, `src/trading/draft-system.ts`, `src/web/trading-routes.ts`

---

## 一、全链路入口与统一管线核查

审计核查了全系统所有可能生成交易建议与草案的入口：
1. **Web API**: `POST /api/web/trading/drafts/auto`
2. **CLI**: `eve-agent draft-auto`
3. **策略扫描器**: `RegionalHaulingStrategy.scan`, `StationArbitrageStrategy.scan`
4. **后台守护任务**: `DraftSystem.createDraft`

### 穿透核查结论:
- **过去隐患**: 策略扫描器产出的 `TradeOpportunity` 曾可能在 Web 路由与 CLI 中未经验证直接塞入 `DraftSystem.createDraft`。
- **P8.5.2 加固**:
  在 `DraftSystem.createDraft` 中实施最终门禁：
  ```typescript
  if (opp.opportunityRating === 'D' || opp.riskVetoReason) {
    throw new Error('【风控一票否决】该交易机会评级为 D (' + (opp.riskVetoReason || '高风险未通过') + ')，严禁生成交易订单草案！');
  }
  ```
  任何尝试绕过管线、试图为 D 级机会创建草案的调用，均在底层数据库写入前被直接抛出异常拦截。

---

## 二、D 级一票否决与防穿透测试

在 `tests/unit/p8-5-2-stress.test.ts` (Scenario H) 中执行反向攻击测试：
- 构造评级为 D 的恶意套利机会（模拟虚假价差与时差超限）。
- 绕过 `TradingPipeline` 直接调用底层 `DraftSystem.createDraft(db, 3001, badOpp)`。
- **测试结果**: 系统直接抛出 `【风控一票否决】` 异常，草案生成数量为 0。彻底证明无法穿透。
