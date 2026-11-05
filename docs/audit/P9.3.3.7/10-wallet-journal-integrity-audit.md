# 10 钱包 Journal、能力快照与游标完整性审计

## 独立验证

`tests/audit/p9-3.3.7/wallet-cursor-integrity-audit.test.ts` 直接调用当前 `P93EsiEvidenceService`，使用隔离 SQLite，覆盖 13 项测试：

- 8 类严格类型反例：字符串 `is_buy`、字符串/零 `transaction_id`、非整数 `type_id`、零 `quantity`、无限 `unit_price`、非法日期、缺失 `location_id` 均拒绝。
- 无 wallet scope 时主动建立/刷新能力快照，并在任何网络调用前以 `WALLET_SCOPE_MISSING` 拒绝。
- transaction 100 写入失败、101 成功时，批次返回 error，`last_transaction_id` 保持 null，100 进入失败队列。
- 解除故障后重试可导入 100 与 101；第三次同步为 `imported=0, skipped=2`，交易、证据和关联均不重复。
- 畸形记录不会推进游标，并进入 `TRANSACTION_DATA_INVALID` 失败状态。
- 钱包分页超限不提交交易或游标。
- 钱包 fetch 飞行中发生角色所有权转移时返回 `IDENTITY_CHANGED`，不写入记录。

上述 13 项全部通过，日志为 `logs/p9337-expanded-audit.log`。

## 代码路径

- `src/trading/p9-3-evidence-service.ts`：使用 pinned `characterId` 建立能力快照、检查 wallet scope、获取/验证分页、严格标准化、持久失败队列和保守游标。
- `src/db/migrations.ts`：存在 wallet transaction cursor、lease 和 failure queue 表。
- `real_esi_transaction_failures` 使失败 transaction 可在后续同步重试。

## 仍存在 F-P9337-05（P1）

钱包同步自身的失败-重试逻辑通过，但游标与失败队列仅按 `character_id` 分区，不使用 owner/chat/binding lineage。

角色 A 已同步 transaction 101 后转移给 owner B，若 B 的钱包当前仅有 transaction 100：

1. B 读取旧 owner 留下的 `startCursor=101`；
2. transaction 100 被当作历史重复而 skipped；
3. 同步返回 `ok:true`，`lastTransactionId=101`；
4. transaction 100 永久漏导。

独立证据：`tests/audit/p9-3.3.7/wallet-owner-cursor-audit.test.ts`，日志 `logs/p9337-expanded-audit.log`。

## 结论

- 钱包记录级校验、失败重试、幂等、分页和 in-flight ownership fencing：本轮独立测试通过。
- 钱包游标跨 owner 继承：**仍未修复，P1 阻断**。
- 证据等级：真实服务代码 + 隔离 SQLite；真实 ESI/token/生产钱包未验证。