# P8.5.5 凭证完整调用链审计

## 真实调用链

~~~text
TradingPipeline.evaluateCandidate
  -> build marketSnapshotHash and opportunityId
  -> construct unsigned PipelineVerificationCredential
  -> signPipelineCredential
  -> TradeOpportunity.pipelineCredential
  -> DraftSystem.createDraft
  -> db.transaction
  -> validateAndConsumePipelineCredential
  -> validatePipelineCredential
  -> consumed_pipeline_credentials insert
  -> trade_drafts insert
  -> transaction commit
~~~

源码位置：

- src/trading/trading-pipeline.ts:386 生成 marketSnapshotHash。
- src/trading/trading-pipeline.ts:387 生成 opportunityId。
- src/trading/trading-pipeline.ts:417 调用 signPipelineCredential。
- src/trading/trading-pipeline.ts:203 定义 validateAndConsumePipelineCredential。
- src/trading/draft-system.ts:31-81 创建草案。
- src/trading/draft-system.ts:37-42 使用 db.transaction 包裹验证、消费和写入。

## 完整性绑定核验

| 字段 | 状态 | 证据 |
|---|---|---|
| credentialId | PASS | 纳入 v3 JSON 规范化；由 randomUUID/时间戳生成 |
| characterId | PASS | 签名字段；validatePipelineCredential 以 expectedCharacterId 校验 |
| accountId | EQUIVALENT | 当前模拟账户由 PT-ACC-<characterId> 派生；未单独签入凭证，characterId 是现有隔离边界 |
| opportunityId | PASS after repair | 生成、签名、并与 TradeOpportunity.opportunityId 一致校验 |
| typeId | PASS | 签名并在 validatePipelineCredential 对照机会 |
| strategy | PASS | 签名并对照机会 |
| buyStationId / sellStationId | PASS | 签名并对照机会 |
| suggestedBuyPrice / suggestedSellPrice | PASS | 签名并以 0.01 ISK 容差对照机会 |
| suggestedQuantity | PASS | 整数校验、签名并严格对照 |
| capitalRequired | PASS | 有限金额、签名并对照机会 |
| expectedNetProfit | PASS after repair | 纳入签名，并新增机会一致性校验 |
| opportunityRating | PASS | 签名并对照；D 级拒绝 |
| marketSnapshotHash | PASS after repair | 全 SHA-256；与 TradeOpportunity.marketSnapshotHash 对照 |
| marketSnapshotHash 内容 | PARTIAL | 哈希覆盖买卖盘前 3 档，但没有独立 snapshotId 表 |
| buy/sellSnapshotTimestamp | PARTIAL | DataQuality 有快照年龄和偏移；凭证未携带两侧精确时间戳 |
| feeModelVersion | UNVERIFIED | 当前凭证没有 feeModelVersion 字段；只能追溯到 Git/代码版本 |
| riskAssessmentHash | EQUIVALENT | rating、vetoReason、stressTest、dataQuality 进入机会评估；未单独哈希签入 |
| pipelineVersion | PASS | 规范化 schema 为 eveai-pipeline-credential-v3 |
| verifiedAt / expiresAt / nonce / keyId | PASS | 签名；expiresAt 有 15 分钟时效检查；nonce 参与签名并由 credentialId 单次消费防重放 |

## 签发与绕过检查

- 生产签发入口集中在 TradingPipeline.evaluateCandidate。
- signPipelineCredential 是导出函数，可用于测试或服务端内部签发；不存在 HTTP/API 直接暴露签发接口的证据。
- DraftSystem.createDraft 不信任客户端已验证结果，而是在服务端重新执行 validateAndConsumePipelineCredential。
- 模型工具没有直接调用 signPipelineCredential 的入口。
- CLI 不能直接创建带有效签名的凭证；创建草案路径仍要求签名校验。

## 结论

核心签发到草案创建链路完整，修复后关键交易参数、机会 ID 和行情快照均被绑定。仍缺少独立快照 ID、快照两侧精确时间和 feeModelVersion，因此不能把“完整上下文”表述为绝对完备；这些字段缺口记录为审计限制。
