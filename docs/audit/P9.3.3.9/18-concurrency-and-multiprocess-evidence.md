# 18 并发与多进程证据

## 1. 覆盖矩阵

| 场景 | 测试 | 重复 | 结果 |
|---|---|---:|---|
| 钱包低 ID 失败恢复 | `multiprocess-wallet-recovery.test.ts` | 5 轮，两进程 | 通过 |
| stale/new-owner 冲正竞争 | `multiprocess-ledger-race.test.ts` | 5 轮，两进程 | 通过 |
| 资产旧页读取与 latest 切换 | `asset-pagination-and-fencing.test.ts` | 5 轮 | 通过 |
| 回收 generation 的 heartbeat | `asset-pagination-and-fencing.test.ts` | 5 轮 | 通过 |
| 两 lane 重复替换 | `asset-mirror-and-pagination.test.ts` | 5 轮 | 通过 |
| FIFO 冲正/重算确定性 | `fifo-adversarial.test.ts` | 5 轮 | 通过 |
| migration SIGKILL 恢复 | `migration-process-interruption.test.ts` | 5 轮独立 kill | 通过 |

## 2. 钱包多进程恢复

- 两个独立 Node 进程访问同一隔离 SQLite。
- 低 ID transaction 先失败。
- 竞争重试同一失败记录。
- 结果无重复交易、重复证据或重复关联。
- 游标保持安全边界。

## 3. REAL 账本多进程竞争

- 两个进程通过共享 barrier 同时发起 stale-owner/new-owner 冲正。
- 5/5 轮拒绝。
- 未发生授权检查后的事实修改。
- 财务触发器未放宽。

## 4. 资产 generation fencing

- 旧 generation 被新 generation 回收后，旧 heartbeat 被拒绝。
- 分页客户端固定 snapshot_id。
- latest 切换不污染旧页。
- 5 轮结果稳定。

## 5. 结论边界

这些是进程级和 SQLite 文件级证据，不是生产多实例证据。尚未验证：

- PostgreSQL/分布式数据库（若未来使用）。
- 多主机时钟偏差。
- 实际网络分区。
- 生产负载和长事务。
- 真实 ESI 限流。

## 6. 证据等级

- 代码验证：已完成。
- 隔离测试数据验证：已完成，包含多进程和 SIGKILL。
- 真实环境验证：无。
- 尚未验证：生产多实例与真实外部系统并发。
