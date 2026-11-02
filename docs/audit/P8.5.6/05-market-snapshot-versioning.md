# P8.5.6 行情快照身份、时间和版本绑定

## 绑定字段

PipelineVerificationCredential 新增并签名：

- marketSnapshotId
- buySnapshotTimestamp
- sellSnapshotTimestamp
- feeModelVersion

类型位置：src/trading/types.ts:102 附近。

## 生成

src/trading/trading-pipeline.ts:469-473：

- marketSnapshotId = MSNAP- + SHA-256 前缀。
- buySnapshotTimestamp 取 origin market_snapshot_regions.fetched_at。
- sellSnapshotTimestamp 取 destination market_snapshot_regions.fetched_at。
- normalizeSnapshotTimestamp 处理缺失/SQLite 时间格式。

## 验证

src/trading/trading-pipeline.ts:223-231：

- 快照 ID、hash、双侧时间任一不同，拒绝。
- feeModelVersion 不同，拒绝。

测试：tests/unit/p8-5-6-signing-key-revocation.test.ts:90。

结论：快照拥有独立身份、双侧精确时间和费用模型版本绑定。
