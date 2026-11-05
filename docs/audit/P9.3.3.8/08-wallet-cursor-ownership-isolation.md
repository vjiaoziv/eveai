# 08 钱包游标所有权隔离

## 1. 游标语义

钱包游标不是“最高见过的 ID”，而是“已安全处理的持久边界”。只要边界内仍有失败记录，游标就不能越过它。

修复后的状态表按以下 lineage 隔离：

```text
(character_id, owner_user_id, owner_chat_id, binding_epoch)
```

旧 owner/lane 的游标不会作为新 owner/lane 的起点。

## 2. 持久失败队列

`real_esi_transaction_failures` 保存：

- failure key；
- transaction_id（畸形行可为 NULL）；
- error code；
- error message；
- first_failed_at、last_failed_at、retry_count；
- lineage。

持久失败的目的：

1. 单条导入失败不静默丢失；
2. 低 ID 失败阻止游标推进；
3. 下次同步可以重新导入；
4. 失败记录可被后续修正覆盖为成功；
5. 重复批次不会重复创建 transaction/evidence/association。

## 3. 保守推进规则

- 先完成全部 ESI 分页；
- 先验证所有关键字段；
- 对可导入行逐笔事务写入；
- 有失败时保持 `status = error` 和旧边界；
- 只有当前边界内没有阻塞失败才推进；
- SQL upsert 对游标取最大安全值，迟到任务不能把游标回退；
- 游标写入与身份校验在同一事务，提交前再次校验绑定。

页面超限、页头不一致、空页声明矛盾、重复 transaction_id、畸形记录、临时数据库错误都不得提交不完整同步。

## 4. 幂等

- `ledgerKey/source_ref = esi-wallet:<transaction_id>`；
- 证据使用来源引用和 payload hash；
- 证据关联去重；
- 同一批次重复同步只更新已有证据/关联，不重复创建；
- 临时失败重试时，已成功的高 ID 可保留，但低 ID 仍会重放，游标不越过它。

## 5. 测试覆盖

- `tests/unit/p9-3.3-evidence.test.ts`：严格字段、分页、失败低 ID、幂等重试、缺 scope、过期快照、固定角色。
- `tests/unit/p9-3.3-wallet-routes.test.ts`：路由 403/422/502，角色切换和解绑。
- `tests/audit/p9-3.3.8/wallet-cursor-ownership-isolation.test.ts`：新 owner 和第二个 chat lane 不继承游标。
- `tests/unit/p9-3.3.2-wallet-lease-integrity.test.ts`、`p9-3.3.2-wallet-cross-connection-lease.test.ts`、`p9-3.3.2-wallet-multiprocess-lease.test.ts`：租约隔离。
- 5 轮并发日志：`logs/19-concurrency-repeat-5x.log`。

## 6. 剩余风险

当前没有人工“隔离永久无法修复记录”的 UI/路由。持续失败会保留错误和 retry_count，运维必须避免无限盲目重试；真实 ESI 分页和真实多进程锁竞争仍未验证。
