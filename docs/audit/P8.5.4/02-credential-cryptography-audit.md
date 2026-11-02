# EVEAI P8.5.4：HMAC 授权凭证密码学安全审计报告 (02-credential-cryptography-audit.md)

**完成日期**: 2026-11-02  
**关联代码**: `src/trading/trading-pipeline.ts`, `src/trading/draft-system.ts`

---

## 一、凭证载荷完整性与关键绑定字段审计

P8.5.4 对 `PipelineVerificationCredential` 实施了全要素加固，杜绝了此前凭证缺乏身份与快照绑定的安全隐患：

```typescript
export interface PipelineVerificationCredential {
  credentialId: string;
  characterId: number;        // [P0] 绑定角色 ID，实现跨用户/跨角色硬隔离
  opportunityId?: string;     // 绑定原始机会日志
  typeId: number;             // 绑定标的商品 Type ID
  strategy: StrategyType;     // 绑定策略类型
  buyStationId: number;       // 绑定采购空间站
  sellStationId: number;      // 绑定销售空间站
  suggestedBuyPrice: number;  // 绑定采购加权限价
  suggestedSellPrice: number; // 绑定销售加权限价
  suggestedQuantity: number;  // 绑定核准建议数量
  capitalRequired: number;    // 绑定核准本金
  expectedNetProfit: number;  // 绑定核准预期净利
  opportunityRating: OpportunityRating; // 绑定风险评级 (仅限 A 或 B)
  marketSnapshotHash: string; // [P0] 绑定市场订单簿内容 SHA256 摘要
  verifiedAt: string;         // 签发时间戳
  expiresAt: string;          // [P0] 明确授权过期时间戳 (15分钟)
  nonce: string;              // [P0] 防重放防彩虹表 Nonce
  keyId: string;              // [P0] 密钥标识符，支持密钥轮换
  signature: string;          // HMAC-SHA256 签名十六进制串
}
```

---

## 二、签名机制与密码学防篡改审计

1. **规范化无歧义序列化 (`buildCanonicalCredentialPayload`)**:
   - 彻底废除可能受属性排序与类型转换影响的裸 JSON 序列化；
   - 采用显式版本号 `v2` 引导的确定性分隔符串联：
     `v2|keyId|credentialId|characterId|opportunityId|typeId|strategy|buyStationId|sellStationId|suggestedBuyPrice|suggestedSellPrice|suggestedQuantity|capitalRequired|expectedNetProfit|opportunityRating|marketSnapshotHash|verifiedAt|expiresAt|nonce`
   - 浮点数显式执行 `.toFixed(2)` 格式化，消除精度表示分歧。
2. **恒定时间签名比对 (`timingSafeEqual`)**:
   - 废除原代码中的 JavaScript 字符串相等比对 `!==`，改用 Node.js 内置原生 `crypto.timingSafeEqual`。
   - 防止攻击者利用字符逐位比对的响应时间差进行旁路时序攻击。
3. **密钥管理与轮换支持 (`keyId`)**:
   - 签名包含 `keyId`（当前默认 `v1`）；
   - 服务端内置 `PIPELINE_KEY_STORE` 字典；当需要废除旧密钥时，注销字典对应条目即可瞬间使所有旧凭证失效。
