# 资产同步任务原子申请

## 1. 历史缺陷 F-P9333-01

P9.3.3.3 发现 RUNNING 预检查与 job 插入非原子。P9.3.3.4 将授权、generation 分配、RUNNING job 插入和 lease 写入放入同一 `BEGIN IMMEDIATE` 事务：

- `src/assets/asset-sync-service.ts:328-399`
- 事务开始时先回收过期 RUNNING job。
- 检查现有 lease/job。
- 通过 `MAX(generation)+1` 分配 generation。
- 在同一事务插入 job 与 lease。

数据库另有：

- `real_asset_sync_jobs(character_id) WHERE status='RUNNING'` 部分唯一索引。
- `real_asset_sync_leases.character_id` 主键。
- `migrations.ts:592-678`。

## 2. 独立测试

- T01：两个独立 Node.js 进程竞争同一角色，只允许一个完整 job。
- T02：不同角色可并行持有各自同步通道。
- T07：job 创建后崩溃，后续 generation 可回收过期任务。
- T08：提交事务内崩溃，旧 latest 和镜像保持完整。
- 本轮五进程竞争：5 个独立进程、独立 SQLite 连接、文件屏障，恰好一个所有者。

## 3. 结果

- 协调器路径：**通过**。
- T01/T02/T07/T08 所在 7 文件关键组：28/28，连续 5/5 次通过。
- 五进程测试：1/1，连续 5/5 次通过。

## 4. 边界

数据库级单所有者结论只适用于 `RealAssetSyncService.syncCharacter()`。F-P9335-03 证明 generic asset sync 不取得该 job/lease，仍可形成第二个写入者，因此不能把本专项通过解释为全系统单所有者。

## 5. 证据等级

- 源码和 schema：已验证。
- 隔离 SQLite/多进程：已验证。
- 生产并发与生产数据库：未验证。
