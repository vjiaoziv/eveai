# EVEAI P8.5.3：管线验证凭证机制与防伪造审计报告 (P8_5_3_PIPELINE_CREDENTIAL_AUDIT.md)

**完成日期**: 2026-11-02  
**关联代码**: `src/trading/trading-pipeline.ts`, `src/trading/draft-system.ts`

---

## 一、管线验证凭证 (Pipeline Verification Credential) 机制设计

为彻底杜绝从 API、CLI 或大模型直接伪造参数创建交易草案，P8.5.3 引入了密码学级的管线验证凭证：

```text
[策略初筛候选] ──> 【TradingPipeline.evaluateCandidate 10阶段严格推演】
                                  │
                 (通过 A/B 级评级且无风险否决)
                                  │
                                  ▼
      【签发 PipelineVerificationCredential (HMAC-SHA256 签名)】
                                  │
                                  ▼
   [DraftSystem.createDraft] ──> 【验证凭证签名、时间戳 (<15m) 与参数一致性】
                                  │
                          (任何篡改直接拦截)
```

### 1. 签名载荷与防篡改绑定
```typescript
export interface PipelineVerificationCredential {
  credentialId: string;
  typeId: number;
  strategy: StrategyType;
  buyStationId: number;
  sellStationId: number;
  suggestedBuyPrice: number;
  suggestedSellPrice: number;
  suggestedQuantity: number;
  capitalRequired: number;
  expectedNetProfit: number;
  opportunityRating: OpportunityRating;
  verifiedAt: string;
  signature: string; // HMAC-SHA256(Secret, Payload)
}
```

### 2. 运行时四重校验规则 (`validatePipelineCredential`)
1. **凭证存在性**: 机会对象必须携带 `pipelineCredential`，未经过管线评估的对象直接拒绝。
2. **评级合法性**: 凭证评级必须为 A 或 B，D 级一票否决。
3. **时效性校验**: `Date.now() - verifiedAt < 15 分钟`，超期凭证硬性作废。
4. **数字签名校验**: 服务端密钥重算 HMAC，签名不符说明为伪造或私自签发。
5. **参数镜像校验**: 传入草案的 `typeId`、`quantity`、`prices` 必须与凭证载荷 100% 完全相同，防止“拿 A 商品的凭证创建 B 商品草案”或“评定 2 件私自改成 29 件”。

---

## 二、对抗性测试结果 (p8-5-3-adversarial.test.ts)

- **无凭证伪造草案**: `DraftSystem.createDraft` 抛出 `【凭证缺失】` 阻断 (PASS)。
- **篡改采购数量**: 凭证签发 1,000 件，修改为 50,000 件，抛出 `【参数篡改】` 阻断 (PASS)。
- **篡改商品 ID**: 凭证签发 34，修改为 6675，抛出 `【参数篡改】` 阻断 (PASS)。
- **伪造数字签名**: 替换签名字符串，抛出 `【凭证篡改】` 阻断 (PASS)。
- **过期凭证提交**: 构造 20 分钟前凭证，抛出 `【凭证过期】` 阻断 (PASS)。
