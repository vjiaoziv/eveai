# EVEAI P8.5：草案撤销安全锁死与历史描述审计 (P8_5_DRAFT_STATE_SECURITY_AUDIT.md)

**完成日期**: 2026-11-02  
**关联代码**: `src/trading/draft-system.ts`, `src/web/trading-routes.ts`, `scripts/eve-cli.ts`

---

## 一、历史记录描述客观化纠偏

在 P8 早期报告中，对 `TR-2026-000001` 撤销原因曾使用了“实盘执行导致 -85.63% 亏损”的表述。
- **事实核查**: 用户从未在 EVE Online 客户端中实际下单执行这笔交易！“导致亏损”是基于市场订单簿逆向推导出的**模拟测算损失**，而非真实历史成交。
- **准确修正 (已落地数据库)**:
  > “根据审计时获取的市场订单簿进行模拟成交测算，原草案存在严重虚假价差。按目标数量逐档模拟后，无法按照原定价格完成采购和销售，模拟情景下存在重大本金损失风险。该草案未被证实实际执行，模拟结果不代表真实成交记录。”

---

## 二、四大入口全链路安全物理锁死

为确保被审计撤销的草案（`status = 'audit_revoked'`）永远无法被玩家误操作激活或记录，P8.5 在四个层级实施了硬性防御：

```text
[用户界面 Web UI]  ──>  [REST API 路由]
                           │
[命令行 CLI]       ──>  [业务状态机 DraftSystem] ──> 【状态校验: audit_revoked 抛出安全异常并拦截】
                           │
[AI Agent 工具]    ──>  [数据持久化 SQLite]
```

### 1. 业务核心层 (`DraftSystem`)
- `updateStatus`:
  ```typescript
  if (existing.status === 'audit_revoked' && newStatus !== 'audit_revoked') {
    throw new Error(`【安全阻断】草案 ${draftId} 已被第二轮独立审计永久撤销 (audit_revoked)，禁止重新审批或变更状态！`);
  }
  ```
- `recordManualExecution`:
  ```typescript
  if (existing.status === 'audit_revoked') {
    throw new Error(`【交易阻断】草案 ${draftId} 已被独立审计撤销，判定为虚假价差高危交易，严禁记录或执行！`);
  }
  ```

### 2. REST API 路由层 (`src/web/trading-routes.ts`)
- 对 `/api/web/trading/drafts/:draftId/approve` 与 `/execute` 增加 `try/catch`，捕获业务层异常并返回 HTTP 403 Forbidden 明确错误，拒绝状态篡改。

### 3. 命令行工具层 (`scripts/eve-cli.ts`)
- `cmdDraftApprove` 捕获异常并打印 `[安全拦截]` 告警，阻止命令行强行审批。

### 4. 数据查询层 (`getDrafts`)
- 当查询参数为 `status=active` 时，SQL 显式限定为 `status IN ('draft', 'approved')`，已撤销草案自动对执行清单隐身。

---

## 三、测试用例验证 (Case F)

在 `tests/unit/p8-5-integration.test.ts` 中针对 `TR-2026-000001` 进行直接冲击测试：
1. 尝试调用 `DraftSystem.updateStatus('TR-2026-000001', 'approved')` $\rightarrow$ **精准抛出安全异常 (PASS)**。
2. 尝试调用 `DraftSystem.recordManualExecution` $\rightarrow$ **精准抛出交易阻断异常 (PASS)**。
3. 查询活跃草案列表 $\rightarrow$ **返回为空，不可见 (PASS)**。
