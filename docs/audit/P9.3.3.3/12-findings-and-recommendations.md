# 12 缺陷、残余风险与修复建议

## 1. 缺陷总览

| 编号 | 等级 | 标题 | 当前状态 |
|---|---|---|---|
| F-P9333-01 | P1 | 资产同步 RUNNING 检查与 job 插入非原子，旧响应可覆盖新快照 | 已稳定复现 |
| F-P9333-02 | P2 | 资产 canonical hash 漏掉三个语义字段 | 已稳定复现 |
| F-P9333-03 | P2 | 资产同步服务接受矛盾 characterId 上下文 | 已稳定复现 |
| F-P9333-04 | P2 | 资产 ESI 响应期间角色解绑后仍提交资产和快照 | 已稳定复现 |
| P0 | - | 未发现 | - |

## 2. F-P9333-01：资产同步跨进程竞态

### 等级

**P1，阻断。**

### 文件位置

- `src/assets/asset-sync-service.ts:139-160`
- `src/db/migrations.ts:425-444`

### 触发条件

两个独立 Node 进程几乎同时对同一角色调用 `RealAssetSyncService.syncCharacter()`。

### 调用链

1. 进程 A、B 分别执行 `reclaimStaleJobs()`；
2. 两者分别执行“是否存在 RUNNING job”的 SELECT；
3. 两者都得到不存在；
4. 两者分别 INSERT 自己的 RUNNING job；
5. 两者分别获取 ESI 响应；
6. 两者分别提交资产镜像与 latest 快照；
7. 较旧响应晚提交时覆盖较新响应。

数据库仅对 `job_id` 建主键，并只有普通 `(character_id, started_at)` 索引；没有“每角色最多一个 RUNNING”的部分唯一约束，也没有持久化租约或 fencing token。

### 预期与实际

预期：

- 同一角色同一时刻只有一个有效 RUNNING 同步；
- 任一时刻只能有一个提交者能替换 latest；
- 旧 generation/owner 不得覆盖较新快照。

实际：

- 两个进程都先通过 RUNNING 查询；
- 数据库始终出现 2 个 RUNNING job；
- 一种交错下两个进程均完成：2 个 COMPLETED job、2 个快照，较新响应 quantity=2，最终 latest/mirror 为旧响应值 1；
- 另一种交错下后提交者在 latest 唯一索引处失败：1 个 COMPLETED job、1 个 FAILED job，同步是否成功取决于提交顺序。

### 复现证据

反例：

~~~text
tests/unit/p9-3.3.3-asset-race.test.ts
FINDING: two processes must not both pass RUNNING check and let an older response overwrite the newer snapshot
~~~

测试使用隔离临时 SQLite、WAL、两个独立 Node 子进程和 SQLite prepare barrier，确定性地让双方都通过 RUNNING 检查，再让较旧响应最后提交。复跑结果为失败：

~~~text
jobs length: expected 1, received 2
snapshot count: expected 1, received 2
latest.total_quantity: expected 2, received 1
character_assets.quantity: expected 2, received 1
~~~

### 影响

- 当前资产镜像可能倒退；
- latest 快照可能错误；
- 资产变化记录与后续估值可能建立在旧库存上；
- 破坏同步任务的单写者审计语义；
- 在多实例或并发手动/自动触发环境中属于真实财务数据完整性风险。

### 修复建议

1. 在数据库层强制每角色最多一个 RUNNING job；
2. 将 stale reclaim、RUNNING 检查和 job INSERT 放入单个 `BEGIN IMMEDIATE` 事务；
3. 或建立独立的持久化租约表，使用 owner、expires_at 和递增 generation/fencing token；
4. 每个提交事务必须验证自己仍是当前 owner 且 generation 未过期；
5. latest 快照替换必须拒绝旧 generation；
6. 增加双进程 barrier 测试作为固定质量门禁；
7. 修复后由独立审计重新检查，不得只删除反例。

## 3. F-P9333-02：canonical hash 字段遗漏

### 等级

**P2。**

### 文件位置

`src/assets/asset-sync-service.ts:258-262`

### 根因

canonical 数组仅包含：

- itemId
- typeId
- quantity
- locationId
- locationFlag
- parentItemId

遗漏：

- locationType
- isSingleton
- isBlueprintCopy

### 预期与实际

仅修改上述三个字段时：

- 预期生成新快照并更新镜像；
- 实际返回 `deduped: true`，不更新 latest 和 character_assets。

### 复现证据

~~~text
tests/unit/p9-3.3.3-asset-race.test.ts
FINDING: canonical hash must not dedupe away location_type/is_singleton/blueprint-copy changes
~~~

断言结果：

~~~text
second.deduped: expected false, received true
~~~

### 影响

- singleton、blueprint copy 和 location type 的状态变化不可见；
- 资产快照历史不完整；
- 依赖这些字段的估值、风险判断或 UI 可能使用旧语义；
- 去重会把语义变化误判为无变化。

### 修复建议

1. 将所有参与业务语义和展示判断的字段纳入 canonical 结构；
2. 对数组项使用稳定字段顺序并排序；
3. 建立字段级变化测试，至少覆盖 locationType、isSingleton、isBlueprintCopy；
4. 为 canonical schema 增加版本号，未来字段变化时主动失效旧 hash。

## 4. F-P9333-03：矛盾角色上下文未被拒绝

### 等级

**P2。**

### 文件位置

- `src/assets/asset-sync-service.ts:139-160`
- 授权与 ESI fetch 位置约在 `src/assets/asset-sync-service.ts:190-198`

### 触发条件

调用方传入：

~~~ts
syncCharacter(
  db,
  characterB,
  { ...ctx, characterId: characterA },
  'manual',
)
~~~

### 根因

函数没有校验独立参数 `characterId` 与 `ctx.characterId` 一致。授权和 ESI 调用按 ctx 执行，而 job、snapshot 和 mirror 使用独立参数写入。

### 预期与实际

- 预期：入口立即拒绝矛盾上下文；
- 实际：同步成功完成，并将 A 上下文取得的资产写入 B 的镜像。

### 复现证据

~~~text
tests/unit/p9-3.3.3-asset-race.test.ts
FINDING: asset sync must reject a characterId that contradicts the pinned user context
~~~

断言结果：

~~~text
expected promise to reject, received COMPLETED result with otherCharacterId
~~~

当前路由与自动 worker 未发现直接可达的矛盾调用路径，因此本轮定为 P2，而不是已证实可远程利用的 P1。但服务契约不安全，未来调用方可能直接引入跨角色污染。

### 修复建议

1. 函数入口强制 `ctx.characterId === characterId`；
2. `getEveCapabilities()` 返回角色必须等于目标角色；
3. Token 所属角色必须再次等于目标角色；
4. job、snapshot、mirror 全部从同一 pinned 上下文派生；
5. 增加角色中途解绑、切换和上下文矛盾的回归测试。

## 5. F-P9333-04：角色解绑后仍提交资产快照

### 等级

**P2。**

### 文件位置

- `src/assets/asset-sync-service.ts:190-198`
- `src/assets/asset-sync-service.ts:303-374`

### 触发条件

资产同步已经通过能力预检并发出 ESI 请求，但在响应返回前或提交事务前，目标角色被解绑、角色所有权变化或会话身份失效。

### 调用链

1. `getEveCapabilities()` 在请求开始时检查当前链接；
2. `callEsiOperation()` 获取资产响应；
3. 服务验证响应字段和分页结果；
4. 服务直接进入数据库事务并替换 mirror/snapshot；
5. 提交前没有再次执行角色关联、所有权或 pinned ctx 一致性复核。

### 预期与实际

预期：本地身份或所有权在响应期间失效时，服务必须中止并保留旧镜像。

实际：独立测试在 assets fetch 回调中删除 `eve_character_links` 后，`syncCharacter()` 仍返回 `COMPLETED`，写入 1 条 `character_assets` 和 1 个 `real_asset_snapshots`。

### 复现证据

~~~text
tests/unit/p9-3.3.3-asset-race.test.ts
FINDING: asset sync must abort when the pinned character is unlinked during the ESI response
~~~

断言结果：

~~~text
expected promise to reject, received COMPLETED result
assets: expected 0, received 1
snapshots: expected 0, received 1
~~~

### 影响

- 已解绑或所有权已变化的角色仍可能被写入旧响应；
- 旧上下文产生的资产镜像可能污染后续显示和估值；
- 违反“身份变化时中止同步”的核心验收条件；
- 与 F-P9333-03 根因不同：F-03 是入口参数矛盾，F-04 是入口正确但响应期间身份失效。

### 建议修复

1. 在提交事务前和事务内重新检查目标角色仍关联且属于当前 user/chat；
2. 将身份复核、旧镜像删除、新镜像插入和 latest 切换放入同一事务；
3. 复核失败时将 job 标记 FAILED，保留旧快照，不返回成功；
4. 增加解绑、所有权转移和会话退出三种并发测试；
5. 将身份 generation 与资产 job generation 绑定，统一阻断旧响应提交。

## 6. 已确认正确的 P9.3.3 修复

以下项目在代码与隔离测试范围内通过：

- 钱包同步主动建立能力快照；
- 缺少 wallet scope 时明确失败；
- 钱包同步固定目标角色上下文；
- ESI 参数、Token、证据、账本、失败队列和游标绑定同一角色；
- 低 ID 失败阻止游标越过；
- 畸形记录与分页超限不推进游标；
- 重复钱包同步幂等；
- FIFO 已售 UNKNOWN 与未售 UNKNOWN 分离；
- 未售 UNKNOWN 不污染已实现盈亏和确定性胜率；
- 开放 UNKNOWN 仍使库存成本和资金占用为 N/A；
- 非法钱包余额保留最后有效值；
- 角色资产响应先全量验证，再事务替换；
- REAL/PAPER 隔离和 ESI GET-only 边界保持。

## 7. 残余风险

### R-P9333-01：钱包租约没有递增 fencing token

钱包租约当前通过 owner_id、到期条件和事务内复核隔离旧持有者，已通过现有确定性测试；但没有单调递增 generation。极端时钟、进程暂停或提交边界交错下的旧持有者隔离仍缺少形式化证明。

### R-P9333-02：钱包租约没有续期

长分页或慢 ESI 响应可能超过租约期限。需验证续期策略、过期后旧 owner 的处理，以及是否会造成重复请求或可恢复失败。

### R-P9333-03：提交边界故障注入不完整

尚未在每条交易写入、证据关联、游标推进和事务提交前后执行随机 SIGKILL，不能证明所有崩溃窗口都可安全恢复。

### R-P9333-04：失败队列没有退避和永久失败状态

低 ID 失败可阻塞游标并重试，但长期永久失败会持续阻塞同步；当前没有最大重试、指数退避、人工隔离或告警策略。

### R-P9333-05：生产多实例与 SQLite 行为未验证

资产 P1 已证明在同一文件数据库上可由两个独立 Node 进程触发。生产是否多实例、部署拓扑和文件锁语义仍未知，必须在目标环境验证。

### R-P9333-06：真实财务闭环未验证

真实账户、真实钱包、人工核实、FIFO、费用补录和盈亏闭环均未执行，不得声明 `REAL_ACCOUNTING_OPERATIONALLY_VERIFIED`。

### R-P9333-07：负载相关集成测试不稳定

首次全量测试中 `tests/integration/perimeter-radar.test.ts` 发生一次 SSE jump-location 超时；该文件单独及连续 3 次运行均通过。当前记录为负载相关不稳定测试，不归为已确认 P9.3.3 业务缺陷，但意味着完整门禁仍不能视为稳定重复通过。

## 8. 修复优先级

1. **P1：** 资产同步增加数据库级单 RUNNING 约束或持久化租约，并加入 generation/fencing；
2. **P2：** 资产提交前后重新验证角色关联、所有权和 pinned 上下文；
3. **P2：** canonical hash 纳入全部语义字段；
4. **P2：** `syncCharacter()` 强制目标角色与 pinned 上下文一致；
5. 保留现有反例测试，修复后不得删除或弱化；
5. 执行完整质量门禁，再由独立审计进行第三轮对抗性复审；
6. 复审通过前不得提交为 `P9_3_3_CODE_HARDENED`，不得部署，不得进入 P9.3.4 或 P9.4。

## 9. 最终结论

~~~text
P0: 0
P1: 1
P2: 3
UNIT_INTEGRATION_TESTS: FAIL
CODE_HARDENED: NO
DEPLOYMENT: NO
FINAL_STATUS: P9_3_3_3_AUDIT_FAILED
~~~
