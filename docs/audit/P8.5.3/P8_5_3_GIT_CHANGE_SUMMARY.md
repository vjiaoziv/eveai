# EVEAI P8.5.3：Git 提交与关键代码差异摘要 (P8_5_3_GIT_CHANGE_SUMMARY.md)

**完成日期**: 2026-11-02  
**当前提交**: `deploy/eve-ai-agent`

---

## 一、关键代码变更差异 (Diff Highlights)

### 1. 凭证防伪造门禁 (`src/trading/draft-system.ts`)
```diff
+ import { validatePipelineCredential } from './trading-pipeline.js';
...
   public static createDraft(
     db: Db,
     characterId: number,
     opp: TradeOpportunity,
     validHours = 24,
   ): TradeDraft {
+    // Stage 8 Guardrail: Strictly verify Cryptographic Pipeline Verification Credential
+    const verification = validatePipelineCredential(opp);
+    if (!verification.valid) {
+      throw new Error(verification.reason || '【凭证失效】该机会未通过统一交易管线加密签章核验！');
+    }
```

### 2. 幂等键同键异参冲突防护 (`src/trading/paper-trading.ts`)
```diff
     if (idempotencyKey) {
-      const existing = db.prepare('SELECT order_id FROM paper_trading_orders WHERE idempotency_key = ?').get(idempotencyKey) as any;
+      const existing = db.prepare('SELECT * FROM paper_trading_orders WHERE idempotency_key = ?').get(idempotencyKey) as any;
       if (existing) {
+        if (
+          existing.type_id !== typeId ||
+          existing.order_type !== orderType ||
+          existing.price !== price ||
+          existing.quantity !== quantity ||
+          existing.character_id !== characterId
+        ) {
+          return {
+            success: false,
+            error: '【幂等冲突】相同 idempotencyKey (' + idempotencyKey + ') 不能用于不同参数的订单！已有订单参数: ...',
+          };
+        }
         return { success: true, orderId: existing.order_id };
       }
     }
```
