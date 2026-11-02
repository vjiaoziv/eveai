# EVEAI P8.5.4：基线、Git 状态与变更审计报告 (01-baseline-and-git-audit.md)

**完成日期**: 2026-11-02  
**审计执行**: Codex 独立审计团队  
**基准分支**: `deploy/eve-ai-agent`  
**基准 Commit**: `0b7698e` (feat(p8.5.3): implement cryptographic pipeline verification credentials, true double-entry balance and adversarial security tests)  
**环境组件版本**:
- Node.js: `v22.23.4`
- npm: `10.9.9`
- TypeScript: `Version 6.0.3`
- Vitest: `4.1.11`
- SQLite (better-sqlite3): `3.53.2`

---

## 一、工作区与 Git 状态核验

1. **工作区状态**:
   - `git status` 确认工作树在审计介入前处于干净状态，无未跟踪冲突代码。
2. **提交历史追溯**:
   - `0b7698e` 继承自 `2329222` 与 `c7f2c70`，包含完整的 P8、P8.5、P8.5.1、P8.5.2 与 P8.5.3 审计脉络。
3. **数据库结构与迁移状态**:
   - SQLite 数据库包含完整的 `trade_drafts` (含 `audit_revoked`), `paper_trading_accounts`, `trade_opportunities_log`, `paper_trading_orders`, `paper_trading_journal` 及新增的 `consumed_pipeline_credentials` 表。

---

## 二、P8.5.4 阶段核心变更清单

| 文件路径 | 修改类型 | 核心变更目的 |
|---|---|---|
| `src/trading/types.ts` | 修改 | `PipelineVerificationCredential` 扩展绑定 `characterId`, `marketSnapshotHash`, `expiresAt`, `nonce`, `keyId` |
| `src/trading/trading-pipeline.ts` | 修改 | 实现规范化载荷序列化 `buildCanonicalCredentialPayload`，引入恒定时间签名比对 `timingSafeEqual`，支持 `keyId` 轮换机制 |
| `src/trading/draft-system.ts` | 修改 | 强制调用 `validateAndConsumePipelineCredential`，核查凭证合法性并原子性记录消费记录，杜绝重放 |
| `src/db/migrations.ts` | 修改 | 增加 `consumed_pipeline_credentials` 表迁移，防范跨用户与跨周期重放 |
| `tests/unit/p8-5-3-adversarial.test.ts` | 修改 | 增加跨角色越权盗用测试 (A07) 与凭证二次消费重放阻断测试 (A13) |
