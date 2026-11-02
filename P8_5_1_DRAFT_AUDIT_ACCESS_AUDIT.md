# EVEAI P8.5.1：撤销草案只读追溯与权限隔离审计 (P8_5_1_DRAFT_AUDIT_ACCESS_AUDIT.md)

**完成日期**: 2026-11-02  
**关联代码**: `src/trading/draft-system.ts`, `src/web/trading-routes.ts`, `scripts/eve-cli.ts`

---

## 一、审计追溯的“只读放行、写操作锁死”原则

P8.5.1 明确了对已撤销草案（`status = 'audit_revoked'`，如 `TR-2026-000001`）的权限矩阵：

| 用户操作 | 访问入口 | 系统响应 | 审计判定 |
|---|---|---|---|
| **查看草案详情** | Web 详情页 / CLI `eve-agent drafts` / REST API | 允许查看完整建议买卖价、理论收益及详细撤销原因 | **PASS (合规追溯)** |
| **查看审计原因** | `draft.revokedReason` 字段 | 显示官方审计证据与模拟测算亏损原因 | **PASS (信息公开)** |
| **再次点击审批** | Web POST `/drafts/:id/approve` / CLI `draft-approve` | 抛出安全异常，返回 HTTP 403 Forbidden 强行阻断 | **PASS (物理锁死)** |
| **记录手动执行** | Web POST `/drafts/:id/execute` / CLI `record-trade` | 抛出交易异常，严禁向历史账本注入失效草案交易 | **PASS (物理锁死)** |
| **修改状态** | 数据库事务或 API 接口 | SQLite 触发器/业务层校验拦截，禁止从 `audit_revoked` 回退 | **PASS (不可篡改)** |
| **删除草案记录** | 任何接口 | 物理禁止 DELETE 操作，历史审计痕迹永久封存 | **PASS (证据保全)** |

---

## 二、`TR-2026-000001` 历史描述纠偏复核

- 数据库中已将原先容易引起歧义的“实盘执行导致亏损”彻底纠偏为：
  > “根据审计时获取的市场订单簿进行模拟成交测算，原草案存在严重虚假价差。按目标数量逐档模拟后，无法按照原定价格完成采购和销售，模拟情景下存在重大本金损失风险。该草案未被证实实际执行，模拟结果不代表真实成交记录。”
- 彻底消除了虚构真实交易历史的风险。
