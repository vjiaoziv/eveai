# EVEAI P8.5.3：缺陷修复明细与代码行级对照表 (P8_5_3_DEFECT_REMEDIATION_LOG.md)

**完成日期**: 2026-11-02  
**执行分支**: `deploy/eve-ai-agent`

---

## 一、代码级修改明细

### 1. `src/trading/types.ts`
- **新增接口**: `PipelineVerificationCredential`
- **用途**: 定义数字签名载荷字段（`credentialId`, `typeId`, `strategy`, `prices`, `qty`, `rating`, `verifiedAt`, `signature`），绑定至 `TradeOpportunity`。

### 2. `src/trading/trading-pipeline.ts`
- **新增函数**: `signPipelineCredential`, `validatePipelineCredential`
- **修改函数**: `evaluateCandidate`
- **修复内容**: 在机会评级达到 A/B 级时自动计算 HMAC-SHA256 签章；增加四重校验函数，任何参数篡改或过期立即抛出无效凭证异常。

### 3. `src/trading/draft-system.ts`
- **修改函数**: `createDraft`
- **修复内容**: 强行插入 `validatePipelineCredential(opp)` 门禁，任何未通过管线签名认证的机会严禁落盘为草案。

### 4. `src/trading/paper-trading.ts`
- **修改函数**: `createVirtualOrder`
- **修复内容**: 引入同键同参幂等通过、同键异参抛出 409 冲突机制；升级订单 ID 为 UUID 防重。
- **修改函数**: `executeVirtualOrderAgainstBook`
- **修复内容**: 严格区分买方经纪人费与卖方税费，买方不再多扣销售税。
- **修改函数**: `cancelVirtualOrder`
- **修复内容**: 未成交买单撤销时全额退还剩余 Escrow，无残存锁定。
- **修改函数**: `verifyAccountBalance`
- **修复内容**: 引入库存成本原值，实现借贷平衡自动化验证。

### 5. `src/web/trading-routes.ts` & `scripts/eve-cli.ts`
- **修复内容**: 统一使用 `TradingPipeline` 自动草案生成，增加 D 级机会过滤与错误捕获。
