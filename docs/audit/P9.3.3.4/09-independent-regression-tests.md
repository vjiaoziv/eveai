# 独立回归测试

## 1. 测试文件

| 文件 | 测试数 | 主要覆盖 |
|---|---:|---|
| `tests/unit/p9-3.3.4-asset-job-atomicity.test.ts` | 4 | T01/T02/T07/T08 |
| `tests/unit/p9-3.3.4-asset-fencing.test.ts` | 4 | T03/T04/T05/T06/T19/T20 |
| `tests/unit/p9-3.3.4-asset-canonical-hash.test.ts` | 6 | T09-T12 与完整语义字段 |
| `tests/unit/p9-3.3.4-asset-character-context.test.ts` | 5 | T13/T14、scope、capability、active switch |
| `tests/unit/p9-3.3.4-asset-unbind-race.test.ts` | 4 | T15-T18 |
| `tests/unit/p9-3.3.4-asset-migration.test.ts` | 1 | 旧 schema、唯一索引、触发器、幂等 |
| 历史 `tests/unit/p9-3.3.3-asset-race.test.ts` | 4 | 原始四项反例 |

本轮新增测试共 24 项；纳入历史反例后为 28 项。关键并发联合组为 22 项，排除 character-context 5 项和 migration 1 项。

## 2. 必需矩阵 T01-T20

| 编号 | 场景 | 证据与结果 |
|---|---|---|
| T01 | 两进程同时申请同角色 | T01，通过 |
| T02 | 不同角色并发同步 | T02，通过 |
| T03 | 旧任务晚于新任务返回 | T03/T04/T20，通过 |
| T04 | 旧任务尝试覆盖 latest | T03/T04/T20，通过 |
| T05 | snapshot 提交事务失败 | T05，通过 |
| T06 | latest 唯一约束冲突 | T06，通过 |
| T07 | 创建 job 后进程崩溃 | T07，通过 |
| T08 | 提交事务期间进程崩溃 | T08，通过 |
| T09 | location_type 变化 | T09，通过 |
| T10 | is_singleton 变化 | T10，通过 |
| T11 | is_blueprint_copy 变化 | T11，通过 |
| T12 | 输入顺序变化 | T12，通过 |
| T13 | ctx 与 target 不一致 | T13，通过 |
| T14 | token 角色不一致 | T14，通过 |
| T15 | 同步期间解绑 | T15，通过 |
| T16 | 解绑后重新绑定 | T16，通过 |
| T17 | 提交与解绑并发 | T17a/T17b，通过 |
| T18 | 解绑期间 lease 仍有效 | T17a/T18，通过 |
| T19 | 重复同步 | T19，通过 |
| T20 | 失效后重试，旧 generation 不复活 | T03/T04/T20，通过 |

## 3. 独立进程与连接

`tests/helpers/p9-3.3.4-asset-child.ts` 由父测试用独立 `node --import tsx` 进程启动。每个 child 自己打开 `better-sqlite3` 文件连接，启用 foreign keys、WAL 和 busy timeout。

可控屏障包括：

- `a.checked`/`b.checked`：双方均已越过非权威 RUNNING 查询；
- `b.acquired`：B 已持有 lease 并进入 ESI fetch；
- `fetch-entered`：任务已创建且 ESI 请求开始；
- `commit-blocked`：已进入最终写事务；
- `release-fetch`/`release-commit`：显式释放故障点；
- `unlink-requested`/`unlink-attempting`/`unlink-done`：控制解绑事务；
- `a.done`、`b.completed`：控制确定性交错与 teardown。

这些屏障不依赖 sleep；等待超时只用于防止测试永久挂死。

## 4. 前置状态与观测

每个文件测试通常创建：

- 临时目录和临时 SQLite 文件；
- users、telegram_sessions、eve_accounts、eve_character_links；
- 资产 scope 与 owner hash；
- 迁移后的 job/snapshot/lease/binding-epoch schema。

断言覆盖：

- child exit code 与 stdout/stderr；
- RUNNING/COMPLETED/FAILED job 数量；
- generation 单调性；
- latest snapshot 唯一性和 total_quantity；
- `character_assets` mirror 内容；
- lease 释放；
- snapshot count 与数据哈希版本；
- fetch 次数、URL 中的 characterId、HTTP method；
- rejection 前无 job/mirror/ESI 副作用。

## 5. 重复运行

关键并发、fencing、解绑、canonical hash 和历史反例联合组连续运行 3 次：

```text
Run 1: 5 files, 22/22 passed
Run 2: 5 files, 22/22 passed
Run 3: 5 files, 22/22 passed
```

## 6. 测试隔离

所有新增数据库测试使用 `:memory:` 或 `mkdtemp()` 下的临时 SQLite 文件，并在 teardown 关闭连接、杀 residual children、删除临时目录。没有连接生产数据库，没有写入生产 REAL 账本。
