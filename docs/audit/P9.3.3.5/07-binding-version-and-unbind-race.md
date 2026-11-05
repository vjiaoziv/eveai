# Binding version、解绑和重新绑定竞态

## 1. 协调器机制

迁移创建 `eve_character_binding_epochs` 及 link INSERT/UPDATE/DELETE 触发器，每次绑定变化递增 epoch。

job 保存 `binding_epoch`、`binding_digest` 和 `account_owner_hash`。最终事务重新读取绑定并比较 digest：`src/assets/asset-sync-service.ts:625-632`。

## 2. 协调器测试

- T15：ESI 响应期间解绑，提交被拒绝。
- T16：解绑后绑定同一角色，旧任务仍被拒绝。
- T17a/T18：解绑先线性化，等待中的提交被拒绝，即使 lease 仍存在。
- T17b：提交先线性化，成功快照后再执行解绑。
- 关键组连续 5/5 通过。

协调器语义：如果提交事务先完成，解绑随后完成，可接受已提交快照；如果解绑先完成，旧任务不得写入。

## 3. 新发现的全系统失败

解绑/重绑安全不能通过：

- **F-P9335-01**：去重不验证当前绑定和镜像存在性，导致新绑定后的成功 job 与空镜像共存。
- **F-P9335-02**：`deleteCharacterData()` 只清理 `character_*` 表；`real_asset_snapshots`、items、changes、jobs、valuations、opportunity matches 保留。新 owner 通过路由可读取旧 owner 的快照和数量。
- **F-P9335-03**：generic asset sync 没有 binding epoch/digest 最终校验，旧 owner 在途响应可写回重绑后的角色。

代码：

- `src/db/character-datastore.ts:9-28`
- `src/web/auth-routes.ts:393-416`
- `src/eve/sso.ts:403-412`
- `src/web/asset-routes.ts:291-321`
- `src/eve/character-sync.ts:156-220`

## 4. 结论

- 旧协调器任务的 fencing：通过。
- 解绑/重绑后的全系统安全性：失败。
- 这是本轮审计失败的直接依据之一。

## 5. 证据等级

- 双连接/独立进程竞态：隔离验证通过。
- 路由级旧历史披露：隔离 Fastify + 临时 SQLite 已验证。
- 真实生产所有权转移：未验证。
