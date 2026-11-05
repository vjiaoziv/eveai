# 04. 钱包余额与资产镜像完整性

## 审计范围

- `src/eve/character-sync.ts`
- `src/assets/asset-sync-service.ts`
- `src/db/schema.ts`
- `tests/unit/p9-3.3-character-sync.test.ts`
- `tests/unit/asset-sync.test.ts`
- `tests/unit/p9-3.3.1-audit-asset-integrity.test.ts`

## A. `character-sync.ts` 钱包余额

### 已通过代码验证

- ESI 响应必须是 `number` 且 `Number.isFinite()`：`src/eve/character-sync.ts:223-228`。
- 非法响应抛错，不执行 `character_wallet` upsert：`:226-233`。
- 失败状态写入 `character_sync_state`，`synced_at`/`rows_synced` 保留最后成功值：`:676-700`。
- 字符串 `"not-a-number"` 被拒绝，last-known-good 余额保留：`tests/unit/p9-3.3-character-sync.test.ts:113-130`。

### F-07（P2）负数钱包余额被接受并覆盖最后有效余额

触发条件：

1. 先成功同步余额 1234.5。
2. ESI 返回 `-1`。
3. `syncWallet()` 仅检查 `typeof number && finite`，因此接受负数。
4. 数据库 upsert 将余额写为 -1，并返回成功。

预期：

- 负数属于异常余额，应使本次同步失败。
- 保留 1234.5 与最后一次成功时间。
- `character_sync_state.status = error`。

实际：

```text
第二次同步结果：status = ok
数据库余额：-1（覆盖 last-known-good）
```

证据：

- 独立测试：`tests/unit/p9-3.3.1-audit-asset-integrity.test.ts:136-158`
- 失败于 `:155`，实际 `status = ok`

影响：异常钱包值污染角色资料镜像，可能影响资金展示和依赖余额的用户决策。定级 P2。

修复建议：

- 钱包余额须满足 `Number.isFinite(balance) && balance >= 0`，并使用明确的最大安全范围（若业务定义 ISK 上限）。
- 失败时不得 upsert `character_wallet`。
- 写入前确认 ESI 响应是标量数值，不接受数组、对象、字符串或 null。
- 保持 `character_sync_state.error` 与 `character_wallet.synced_at` 的 last-known-good 分离。

## B. `character-sync.ts` 资产镜像

### 已通过代码验证

`syncAssets()` 当前流程：

1. 请求完整分页结果。
2. 若响应不是数组，立即失败：`character-sync.ts:157-159`。
3. 在打开替换事务前，用 `map()` 验证全部行：`:161-202`。
4. 拒绝非对象、非正 `item_id/type_id/location_id`、非正 `quantity`、非法 `location_type`/`location_flag`、非 boolean `is_singleton`、非法 `is_blueprint_copy`。
5. 拒绝重复 `item_id`：`:200-202`。
6. 验证通过后才开启事务，删除旧资产集并插入新集：`:204-219`。

结论：`character-sync.ts` 的资产路径满足“全批验证后原子替换”，并保留上一份有效镜像。

### 已通过隔离测试验证

- 缺字段导致整批失败，旧 `character_assets` 保持不变：`tests/unit/p9-3.3-character-sync.test.ts:132-158`。
- 既有 `asset-sync.test.ts` 的分页、去重、页面失败、并发锁和历史变化测试：9/9 通过。

## C. `RealAssetSyncService` 仍存在严格性缺陷（F-01，P1）

### 涉及位置

`src/assets/asset-sync-service.ts:201-231`

当前归一化：

```ts
const itemId = intField(record.item_id);
const typeId = intField(record.type_id);
const locationId = intField(record.location_id);
const quantityRaw = intField(record.quantity);
rows.push({
  itemId,
  typeId,
  quantity: quantityRaw !== null && quantityRaw > 0 ? quantityRaw : 1,
  locationId,
  isSingleton: record.is_singleton === true ? 1 : 0,
  isBlueprintCopy: record.is_blueprint_copy === undefined || record.is_blueprint_copy === null
    ? null
    : (record.is_blueprint_copy === true ? 1 : 0),
});
```

### 已确认触发条件

1. `quantity: 0`、负数或缺失：被改成 `1`。
2. `is_singleton: "false"`：被转换成 `0`。
3. `is_blueprint_copy: "true"`：被转换成 `0`。
4. `item_id: 0`、`type_id: -1`、`location_id` 非正数：safe integer 检查通过，随后写入数据库。
5. 重复 `item_id` 未在事务前显式拒绝；数据库主键可能兜底，但错误语义不是明确的全批验证失败。

### 独立测试结果

`tests/unit/p9-3.3.1-audit-asset-integrity.test.ts`：

- `quantity=0`：服务返回成功并提交快照，测试失败。
- 字符串 boolean：服务返回成功并提交快照，测试失败。
- 非正 item/type/location ID：服务返回成功并提交快照，测试失败。

实际输出：

```text
3 tests failed / 4 tests in file
实际：RealAssetSyncService.syncCharacter(...) resolved
预期：reject(/quantity|is_singleton|item_id|.../)
```

### 影响

- 当前资产集可被非法 ESI 响应污染。
- 不可变资产快照记录错误数量/标志。
- 资产变化、对账和估值可能基于错误事实。
- 原子替换机制本身没有失效；问题是“原子地提交了错误数据”。

定级 P1。

### 修复建议

对 `RealAssetSyncService` 复用与 `character-sync.ts` 同等级的全批严格校验：

- `item_id`、`type_id`、`location_id`：正安全整数。
- `quantity`：正安全整数；缺失/0/负数必须整批失败，不得默认 1。
- `is_singleton`、`is_blueprint_copy`：严格 boolean（可选字段缺失时的语义需明确）。
- `location_type`、`location_flag`：按 ESI schema 明确必填/可选与合法枚举。
- 重复 `item_id`：事务前显式拒绝。
- 任一非法行：不删除旧资产、不创建新快照、不写变化记录，作业标记 `FAILED`。

## 配置与状态语义

- `character-sync.ts` 已区分：
  - ESI 请求成功但数据无效；
  - 数据验证失败；
  - 数据库提交失败；
  - 上次成功同步时间。
- `RealAssetSyncService` 的 job `status` 表示作业结果，但不能把结构非法数据标记为成功快照。
- 本轮未修改任何数据库结构或迁移。

## 验证边界

- 已通过代码验证：`character-sync.ts` 钱包/资产边界保护。
- 已通过隔离 SQLite 测试：非法字符串余额、缺字段资产、P9.2 分页/并发/去重。
- 已确认缺陷：`RealAssetSyncService` 对非法数量、字符串 boolean、非正 ID 的接受。
- 已确认缺陷：`character-sync.ts` 对负数钱包余额的接受。
- 真实环境验证：无。