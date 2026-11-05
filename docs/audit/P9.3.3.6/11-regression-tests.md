# 11 回归测试

## P9.3.3.6 专项

8 个测试文件、57 项测试，最终复跑全部通过：

- `p9-3.3.6-asset-writer-unification.test.ts`：3
- `p9-3.3.6-binding-aware-dedup.test.ts`：6
- `p9-3.3.6-lease-heartbeat.test.ts`：8
- `p9-3.3.6-owner-lineage-isolation.test.ts`：5
- `p9-3.3.6-pagination-integrity.test.ts`：10
- `p9-3.3.6-safe-quantity-aggregation.test.ts`：7
- `p9-3.3.6-stale-job-reclamation.test.ts`：5
- `p9-3.3.6-wallet-journal-validation.test.ts`：13

## 历史反例

P9.3.3.1 至 P9.3.3.5 的 33 个测试文件、171 项测试最终复跑全部通过，结果记录在 `13-quality-gates.md`。

## 关键测试技术

- 独立 SQLite 数据库
- 独立连接/必要时独立进程
- 确定性 barrier 和故障注入
- 所有权/epoch 转移
- 伪 child id 越权尝试
- 缺页/分页变化/页预算故障
- SQLITE_BUSY、心跳失败和 stale reclamation

## 未覆盖

没有使用真实 EVE 账号、真实 ESI 响应或生产数据库。隔离测试不能替代生产运营验证。
