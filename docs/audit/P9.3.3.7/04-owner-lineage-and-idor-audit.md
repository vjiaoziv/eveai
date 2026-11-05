# 04 Owner lineage、IDOR 与角色转移审计

## 结论

发现 **F-P9337-01（P0）**：角色所有权转移后，新 owner 可以读取和修改前 owner 的 REAL 账本、证据、审计历史和钱包游标。

## 代码事实

- `src/web/p9-3-routes.ts:18-25`：路由只通过当前链接角色取 `characterId`。
- `src/web/p9-3-routes.ts:119-291`：记录列表、证据和审计接口按 `character_id` 查询/操作，不校验记录创建时的 owner、chat、binding epoch 或 digest。
- `src/db/migrations.ts:708-749`：`real_trade_records` 只有 `character_id`，没有 owner/binding lineage。
- `src/db/migrations.ts:786-803`：`real_trade_evidence` 只有 `character_id`。
- `src/db/migrations.ts:927-959`：钱包游标、失败队列只有 `character_id`，没有 owner 维度。
- `src/db/character-datastore.ts:9-28`：`deleteCharacterData()` 只删除 `character_*` 表。
- `src/web/auth-routes.ts:395-419`：角色转移只删除 profile 数据，不会隔离 REAL 账本。
- `src/eve/sso.ts:403-413`：解绑清理同样只调用 `deleteCharacterData()`。

## 调用链

1. 用户 A 建立角色链接并创建/核实 REAL 交易。
2. SSO/所有权转移将 `eve_accounts.user_id` 改给用户 B，并删除旧 `character_*` profile。
3. 用户 B 打开 P9.3 REAL 路由。
4. `linkedCharacter()` 仅确认 B 当前链接该角色。
5. 路由按 `character_id` 查询/修改所有历史 REAL 记录。
6. 结果：B 获得 A 的交易、证据、审计历史和游标，并可发出冲正。

## 前置条件与复现

- 前置：同一 `character_id` 从 A 转移到 B；B 有有效 web session；A 已写入并核实至少一笔 REAL 交易。
- 反例：`tests/audit/p9-3.3.7/owner-ledger-isolation-audit.test.ts`。
- 操作：B 访问 `GET /api/web/trading/p9/real-ledger/records`、`/evidence`、`/audit`，再调用 `POST /records/:id/reverse`。
- 预期：B 得到空集合或 403/404；旧记录不可读、不可修改。
- 实际：记录和 `OWNER_A_PRIVATE_NOTE`、`OWNER_A_PRIVATE_EVIDENCE` 可见；冲正返回 200，记录变为 `REVERSED`；旧游标仍存在。

## DB/日志证据

- `logs/p9337-expanded-audit.log`：F-P9337-01 通过，说明反例稳定复现。
- 测试断言包含旧记录、旧证据、旧审计与 `record_state=REVERSED`。
- 证据等级：隔离 SQLite + 真实路由/服务代码（B 级）。

## 影响

- 跨用户敏感财务数据泄露。
- 新 owner 可修改/冲正前 owner 的真实账本事实。
- 可继承旧钱包游标，造成新 owner 交易漏同步（见 F-P9337-05）。
- 破坏审计链的可归属性和 REAL 账本可信度。

## 修复建议

- 为所有 REAL 账本表增加 `owner_user_id`、`owner_chat_id`、`binding_epoch`、`binding_digest`、`account_owner_hash` 或独立所有权 envelope。
- 所有读、写、冲正、证据和审计查询都必须带 lineage 条件，不能只按 `character_id`。
- 角色转移必须建立新的 lineage；旧 lineage 记录只能以显式迁移/归档方式处理，不能自动继承。
- 钱包游标和失败队列迁移为按 owner/binding 分区。
- legacy 无 lineage 记录必须 fail closed，不能默认归给新 owner。

## 是否阻断下一阶段

**是。** 在修复并完成独立回归前，不允许进入下一开发阶段。
