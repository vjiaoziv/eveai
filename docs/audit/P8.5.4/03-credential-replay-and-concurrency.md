# EVEAI P8.5.4：重放保护、跨用户隔离与并发授权审计 (03-credential-replay-and-concurrency.md)

**完成日期**: 2026-11-02  
**关联代码**: `src/trading/trading-pipeline.ts`, `src/trading/draft-system.ts`

---

## 一、凭证单次消费与防重放机制 (Anti-Replay)

P8.5.4 在 SQLite 数据库层引入专用凭证消费表：
```sql
CREATE TABLE IF NOT EXISTS consumed_pipeline_credentials (
  credential_id   TEXT PRIMARY KEY,
  character_id    INTEGER NOT NULL,
  draft_id        TEXT NOT NULL,
  consumed_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 原子性消费流程 (`validateAndConsumePipelineCredential`):
1. 在草案创建的数据库事务内，首先查询 `consumed_pipeline_credentials`；
2. 若 `credential_id` 已存在记录，立即抛出致命异常：
   `【凭证重放阻断】验证凭证 CRED-XXX 已经被消费使用过，严禁重复提交生成草案！`；
3. 若未消费，立即向表写入消费存证，与草案落盘绑定在同一个原子事务中。

---

## 二、跨角色越权隔离审计 (Cross-User Isolation)

- **威胁场景**: 用户 A（角色 4001）通过管线评估获得了一笔优质套利凭证，恶意截获后，将其作为角色 B（角色 9999）的入参发起草案创建。
- **系统响应**:
  `DraftSystem.createDraft` 在核验凭证时，将当前请求的角色 ID 与凭证内签名的 `characterId` 进行强比对；
  若不相等，直接抛出 `【跨角色越权】` 异常并拒绝执行。
- **测试证据**: `tests/unit/p8-5-3-adversarial.test.ts` (Adversarial Pipeline 5) 实测断言通过。
