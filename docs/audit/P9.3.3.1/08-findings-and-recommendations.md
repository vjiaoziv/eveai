# 08. 缺陷列表与修复建议

## 汇总

| 编号 | 等级 | 状态 | 标题 |
|---|---|---|---|
| F-01 | P1 | 已确认 | P9.2 真实资产同步仍接受畸形字段 |
| F-02 | P1 | 已确认 | 同角色并发成功可越过另一同步的失败记录 |
| F-03 | P2 | 已确认 | 慢速同角色同步可回退游标 |
| F-04 | P2 | 已确认 | 最终身份检查与游标写入存在 TOCTOU |
| F-05 | P2 | 已确认 | 幂等重试重复追加证据关联事件 |
| F-06 | P2 | 已确认 | 部分 REAL 盈亏页面缺失 freshness 提示 |
| F-07 | P2 | 已确认 | 负数钱包余额覆盖最后有效余额 |

总计：

```text
P0: 0
P1: 2
P2: 5
P3: 0（存在未覆盖项，不冒充已确认缺陷）
```

## F-01（P1）`RealAssetSyncService` 仍接受畸形资产字段

- 涉及文件/位置：`src/assets/asset-sync-service.ts:201-231`
- 触发条件：
  - `quantity` 为 0、负数或缺失。
  - `is_singleton` 或 `is_blueprint_copy` 为字符串。
  - `item_id/type_id/location_id` 为非正 safe integer。
  - 重复 `item_id` 未在事务前显式拒绝（数据库主键可能兜底）。
- 实际路径：
  1. `syncCharacter()` 拉取完整 ESI 数组。
  2. `intField()` 只验证 number + safe integer。
  3. `quantityRaw > 0 ? quantityRaw : 1` 静默修复。
  4. boolean 比较只接受 `true`，其余全部转 0。
  5. 验证后直接进入原子事务，创建新快照。
- 预期：全批严格验证；任一非法行整批失败；旧快照保持不变。
- 实际：独立测试确认 `quantity=0`、字符串 boolean、非正 ID 均被成功提交。
- 影响：当前资产集、不可变资产快照、变化记录、对账和估值可被污染。
- 证据：
  - `tests/unit/p9-3.3.1-audit-asset-integrity.test.ts:102-135`
  - 3 个测试失败。
- 建议修复：
  - 正安全整数校验所有 ID。
  - `quantity` 必须为正整数，非法即整批失败。
  - boolean 严格 `typeof === 'boolean'`。
  - 重复 `item_id` 在事务前拒绝。
  - 复用/抽取 `character-sync.ts` 的严格归一化规则。

## F-02（P1）同角色并发成功可越过另一任务的失败记录

- 涉及文件/位置：
  - `src/trading/p9-3-evidence-service.ts:211-215`
  - `src/trading/p9-3-evidence-service.ts:316-425`
  - `src/trading/p9-3-evidence-service.ts:438-456`
- 触发条件：
  - 角色 A 已有游标 100。
  - 任务 X 收到 150（畸形）+ 200（合法），X 将状态写为 error。
  - 任务 Y 同时只收到 200，成功后将游标写成 200 / ok。
- 预期：游标不越过未成功处理的 150；失败状态不被成功任务覆盖。
- 实际：`{last_transaction_id: 200, status: 'ok'}`，150 可被永久跳过。
- 影响：账本交易遗漏、证据缺失、状态误报。
- 证据：`tests/unit/p9-3.3.1-audit-wallet-concurrency.test.ts:189-221`。
- 建议修复：
  - 单角色同步租约/互斥。
  - 持久化失败队列与安全游标。
  - 终态 CAS，条件更新。
  - 状态、错误、游标同一事务。

## F-03（P2）慢速同角色同步回退游标

- 涉及文件/位置：`src/trading/p9-3-evidence-service.ts:211-215,438-456`
- 触发条件：两个任务从旧游标启动，先完成者写 200，后完成者根据旧快照写 150。
- 预期：终态保持 200。
- 实际：终态退化为 150。
- 影响：重复回扫、状态抖动、错误边界失真。
- 证据：`tests/unit/p9-3.3.1-audit-wallet-concurrency.test.ts:161-187`。
- 建议修复：CAS `newLastId >= currentLastId`，禁止回退；与 F-02 一并实现单角色互斥。

## F-04（P2）最终身份检查与游标写入之间 TOCTOU

- 涉及文件/位置：`src/trading/p9-3-evidence-service.ts:427-456`
- 触发条件：最终身份检查通过后，在游标 INSERT 执行时角色链接被删除。
- 预期：返回 `IDENTITY_CHANGED`，不提交游标。
- 实际：返回 `ok: true`，游标 INSERT 未被身份断言阻止。
- 影响：角色解绑后旧请求仍可报告同步成功并落游标。
- 证据：`tests/unit/p9-3.3.1-audit-wallet-concurrency.test.ts:250-268`。
- 建议修复：
  - 终态身份检查、状态更新、游标写入放入同一 `BEGIN IMMEDIATE` 事务。
  - 使用 ownership/version token 做 CAS。
  - 失败时回滚事务并返回 `IDENTITY_CHANGED`。

## F-05（P2）幂等重试重复追加证据关联事件

- 涉及文件/位置：`src/trading/p9-3-ledger-service.ts:638-645`
- 触发条件：已存在 `(evidence_id, record_id)` 关联时再次调用 `linkEvidence()`。
- 预期：关联 upsert 不产生重复事实；事件最多表示一次 new link。
- 实际：关联仍为 1 条，但 `evidence_linked` 事件变为 2 条。
- 影响：审计事件计数与真实关系变化不一致。
- 证据：`tests/unit/p9-3.3.1-audit-wallet-concurrency.test.ts:223-248`。
- 建议修复：事务内先判断关联是否存在；仅新插入时写 `evidence_linked`；更新使用独立事件类型。

## F-06（P2）部分 REAL 盈亏页面缺失 freshness 提示

- 涉及文件/位置：
  - `web/src/components/P93AccountingPanel.tsx:426-445`
  - `src/web/p9-routes.ts:199-247`
  - `web/src/components/P9TradingScreen.tsx:320-322,533-544`
- 触发条件：FIFO 结果已 STALE/NEVER_CALCULATED，但用户进入兼容 overview 或 P9 盈亏页。
- 预期：所有 REAL 财务结果统一展示 freshness，非 CURRENT 时明确警告。
- 实际：部分页面只展示数字，没有 freshness 字段或警告。
- 影响：旧结果显示为当前结果，用户可能基于过期盈亏做决策。
- 证据：源码复核；独立 freshness 测试证明服务层状态正确，但前端显示未全覆盖。
- 建议修复：兼容 API 返回 `performance.freshness`；统一组件 banner/门禁；保留旧值但标注 STALE。

## F-07（P2）负数钱包余额覆盖最后有效余额

- 涉及文件/位置：`src/eve/character-sync.ts:223-233`
- 触发条件：钱包接口返回 `-1`。
- 预期：负余额视为异常，本次同步失败，保留 last-known-good。
- 实际：负数通过有限数值检查，写入 `character_wallet` 并标记 `ok`。
- 影响：角色资料钱包镜像被异常值污染。
- 证据：`tests/unit/p9-3.3.1-audit-asset-integrity.test.ts:136-158`。
- 建议修复：增加 `balance >= 0`（及适用上限）校验；失败时不 upsert 余额；保持错误状态与最后成功时间分离。

## 修复优先级

### 第一优先级（合并前必须）

1. F-02：单角色同步线性化、失败队列、CAS 游标。
2. F-01：`RealAssetSyncService` 全批严格验证。
3. F-04：终态身份事务化。

### 第二优先级

4. F-03：游标禁止回退（与 F-02 同批修复）。
5. F-05：证据关联事件幂等。
6. F-07：钱包余额非负校验。
7. F-06：所有 REAL 财务页面统一 freshness。

## 复审建议

修复后至少重新执行：

```bash
npx vitest run \
  tests/unit/p9-3.3.1-audit-asset-integrity.test.ts \
  tests/unit/p9-3.3.1-audit-wallet-concurrency.test.ts \
  tests/unit/p9-3.3.1-audit-freshness.test.ts

npm run typecheck
npm run web:check
npm test
npm run lint
npm run build
npm run audit:public
git diff --check
```

复审必须确认：

- 独立审计套件全部通过。
- 全量测试中不再有由确认缺陷引起的失败。
- 数据库并发/身份测试仍在实际事务和故障注入下通过。
- 未通过删除断言、放宽数据库触发器或跳过测试来“修复”。

## 最终状态

```text
P9_3_3_1_AUDIT_FAILED
REAL_ACCOUNTING_OPERATIONALLY_VERIFIED = 未达成
```

在 P1 修复并复审通过前，暂停提交和部署；不允许进入 P9.3.4，不允许启动 P9.4。