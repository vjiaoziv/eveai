# 08 ESI 分页完整性审计

## 资产分页

独立反例 `historical-regression-audit.test.ts` 已验证：

- 缺失 `X-Pages` 时拒绝把响应当作单页完整结果，上一完整 snapshot 和 mirror 保留。
- 聚合数量超过安全整数范围时 fail closed，不替换上一完整结果。
- 同步仅在完整响应验证通过后，由 `RealAssetSyncService` 的最终事务提交 mirror、snapshot、items 和 job 完成状态。

既有 P9.3.3.6 回归另覆盖页数变化、非整数页数、预算超限和多页合并。本轮历史回归为 33 文件 / 171 测试通过。

## 钱包分页

独立测试 `wallet-cursor-integrity-audit.test.ts` 已验证：

- `X-Pages=11` 超过允许上限时返回错误；
- 不写入交易记录；
- 同步状态写为 error，`last_transaction_id` 保持 null，不提交不完整批次。

此外，`historical-regression-audit.test.ts` 验证非数组 wallet journal 响应会被拒绝，且 mid-batch 写入失败时事务回滚。

## 结论

本轮没有复现 F-P9335-04，也没有发现“分页超限仍提交不完整结果或推进游标”的路径。

## 限制

- 未连接真实 ESI，未验证真实 `X-Pages` jitter、限流、重试、ETag 和代理异常。
- 未做生产 SQLite 锁竞争、多实例网络故障和真实钱包页序变化。
- 证据等级：代码验证 + 隔离 SQLite 测试数据验证；真实环境未验证。