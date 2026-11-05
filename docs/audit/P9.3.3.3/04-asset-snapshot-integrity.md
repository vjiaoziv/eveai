# 04 资产快照完整性与原子性

## 1. 已通过的完整性修复

当前 RealAssetSyncService 已实现：

- 整批严格验证 item_id/type_id/location_id/quantity；
- location_type 枚举校验；
- location_flag 必须为非空字符串；
- is_singleton 必须为 boolean；
- is_blueprint_copy 若存在必须为 boolean；
- 重复 item_id 拒绝整批；
- 任一分页或任一行失败不替换旧资产镜像；
- 删除旧镜像、插入新镜像、快照元数据和变化记录处于同一 SQLite 事务；
- 数据库提交失败时整体回滚。

源码位置：

- src/assets/asset-sync-service.ts:139-270；
- src/assets/asset-sync-service.ts:288-367。

既有专项测试验证了：

- 第二页畸形时保留旧快照；
- 后续页请求失败时不提交部分分页；
- 数据库提交失败时事务回滚。

## 2. F-P9333-01 P1：并发启动与旧响应覆盖

### 触发条件

两个独立 Node 进程几乎同时调用同一角色的 syncCharacter。

### 实际调用链

1. 两个进程分别执行 reclaimStaleJobs；
2. 两个进程分别 SELECT 是否存在 status = RUNNING；
3. 两者都得到“没有 RUNNING”；
4. 两者分别 INSERT 新的 RUNNING job；
5. 两者分别获取 ESI 响应并执行提交事务；
6. 较旧响应可能晚于较新响应完成，覆盖 character_assets 和 latest snapshot。

### 根因

- RUNNING 检查与 INSERT 之间没有数据库级原子锁；
- real_asset_sync_jobs 没有“每角色最多一个 RUNNING”的部分唯一索引；
- 没有类似钱包同步的持久化租约或 fencing token；
- 最新快照由提交顺序决定，而不是由请求开始时间、版本或 generation 决定。

数据库定义见 src/db/migrations.ts:425-444；检查/插入见 src/assets/asset-sync-service.ts:145-160。

### 实际结果

独立双进程测试使用确定性 barrier，两个进程都能先通过 RUNNING 查询。实际观察到两种交错结果：

1. 两个进程均完成：real_asset_sync_jobs 出现 2 个 COMPLETED、real_asset_snapshots 出现 2 个快照，旧响应 quantity=1 覆盖新响应 quantity=2，latest/mirror 均为 1；
2. 两个进程均插入 RUNNING job，但其中一个在提交 latest 快照时撞上部分唯一索引，job 变为 FAILED，另一个完成，数据库仍留下 2 个 job。最终快照取决于提交顺序。

两种结果都证明缺少数据库级单写者/旧 generation 隔离；第一种造成旧响应覆盖，第二种造成一次同步失败和任务审计歧义。

### 影响

- 使用旧资产响应覆盖较新资产镜像；
- 资产变化记录和后续估值可能基于错误当前快照；
- 财务报表可能把旧库存当成当前库存；
- 两个完成 job 破坏任务审计语义。

等级：P1。

### 建议修复

1. 为每角色 RUNNING job 增加数据库级唯一约束；或复用持久化租约表；
2. 把 stale reclaim、RUNNING 检查和 INSERT 放入 IMMEDIATE 事务；
3. 使用 generation/fencing token，禁止旧 generation 提交；
4. 提交时校验 job 仍为当前 owner；
5. 增加独立进程确定性测试作为验收门禁。

## 3. F-P9333-02 P2：canonical hash 漏字段

当前 canonical 数组只包含：

- itemId
- typeId
- quantity
- locationId
- locationFlag
- parentItemId

源码：src/assets/asset-sync-service.ts:258-262。

遗漏：

- locationType
- isSingleton
- isBlueprintCopy

实际测试中，只修改这三个字段时，第二次同步返回 deduped=true，未生成新快照，旧镜像保持不变。

影响：

- 资产分类、singleton/blueprint 状态变化不可见；
- 快照历史与资产变化审计不完整；
- 依赖这些字段的估值或 UI 可能使用旧语义。

建议把全部语义字段纳入稳定排序后的 hash，并增加字段级变更回归测试。

## 4. F-P9333-03 P2：服务契约接受矛盾 characterId

syncCharacter(db, characterId, ctx) 不检查：

~~~text
ctx.characterId !== undefined && ctx.characterId !== characterId
~~~

随后 getEveCapabilities 和 ESI 按 ctx 解析授权/角色，而持久化始终使用独立参数 characterId。

独立测试传入 characterId=B、ctx.characterId=A，服务成功完成并写入 B 的资产镜像。

当前路由与自动 worker 都显式传入与目标一致的 pinned ctx，因此暂未发现生产入口直接可达路径；但服务契约本身不安全，任何未来调用方都可能触发跨角色污染。

建议在函数入口强制：

- 若 ctx.characterId 已定义则必须等于 characterId；
- getEveCapabilities 返回的 characterId 必须再次等于目标；
- ESI token 绑定角色必须再次等于目标；
- 写入 job、snapshot、mirror 使用同一目标角色。

## 5. F-P9333-04 P2：角色解绑后仍提交资产快照

### 触发条件

资产同步在 `getEveCapabilities()` 之后、ESI 资产响应返回之前，目标角色被解绑或角色所有权发生变化。

### 调用链

1. 服务按目标 ctx 建立能力快照并获取 ESI 资产；
2. ESI 响应返回前，角色关联被删除或所有权变化；
3. 服务完成字段校验；
4. 服务直接进入事务，删除旧镜像、插入新镜像和新快照；
5. 服务没有在提交前重新调用 `getLinkedCharacter()` 或执行等价身份复核。

### 预期与实际

预期：身份、所有权或上下文失效时中止，保留上一份有效资产镜像和快照。

实际：独立测试在 ESI assets 响应回调中删除 `eve_character_links`，服务仍以 `COMPLETED` 返回，提交 1 条资产并生成新快照。

### 复现证据

~~~text
tests/unit/p9-3.3.3-asset-race.test.ts
FINDING: asset sync must abort when the pinned character is unlinked during the ESI response
~~~

实际断言结果：

~~~text
expected promise to reject, received COMPLETED result
character_assets count: 1（期望 0）
real_asset_snapshots count: 1（期望 0）
~~~

### 影响

- 角色已在本地解绑或所有权变化后，仍可能写入旧请求取得的资产；
- 新所有者或后续读取方可能看到旧上下文产生的资产镜像；
- 破坏“身份变化必须阻断旧任务写入”的验收要求；
- 与 F-P9333-03 属于不同根因：F-03 是入口上下文矛盾，F-04 是入口正确但响应期间身份失效。

等级：P2。当前反例直接命中服务级契约和资产数据完整性，但未构造出跨用户读取已提交快照的直接路径。

### 建议修复

1. 在资产提交事务前后再次复核目标角色仍存在、属于当前用户、且 ctx/characterId 一致；
2. 把复核、资产删除/插入、快照切换放入同一事务边界；
3. 复核失败时保留旧快照并将 job 标记 FAILED，不得提交新镜像；
4. 增加角色解绑、所有权转移、会话退出三类并发回归测试；
5. 与 F-P9333-01 的 generation/owner 校验统一设计。


## 6. 资产结论

资产同步满足“单次响应全量验证 + 事务替换”，但不满足“跨进程单写者 + 完整语义 hash + 统一角色上下文 + 响应期间身份复核”的验收标准。

因此不能标记资产快照完整性通过。
