# 07. 测试覆盖与复现结果

## 测试环境

- 仓库：`/home/ubuntu/projects/eveai`
- 分支：`deploy/eve-ai-agent`
- HEAD：`9e8e8b32d0e065c6d8479140f94662087193279d`
- 测试数据库：内存 SQLite（独立实例，`runMigrations()` 建表）
- 未连接生产数据库，未写入真实 REAL 账本
- 未执行部署或生产迁移

## 既有专项套件

命令：

```bash
npx vitest run \
  tests/unit/p9-3.3-evidence.test.ts \
  tests/unit/p9-3.3-fifo.test.ts \
  tests/unit/p9-3.3-character-sync.test.ts \
  tests/unit/p9-3.3-wallet-routes.test.ts \
  tests/unit/p9-3-hardening.test.ts \
  tests/unit/p9-3-real-accounting.test.ts \
  tests/unit/asset-sync.test.ts
```

结果：

```text
7 test files passed
78 tests passed
exit code 0
```

覆盖：

- 钱包字段严格校验、能力快照、固定角色、scope 缺失、分页失败、保守游标。
- FIFO UNKNOWN 分离、胜率、哈希稳定、freshness。
- 角色资料钱包/资产异常保护。
- 路由级 403/502、身份切换和解绑。
- REAL/PAPER 隔离、ESI 证据真实性、AI actor 拒绝、数据库不可变约束。
- P9.2 资产同步分页、原子快照、去重、并发锁和历史变化。

## 独立审计套件

新增文件：

- `tests/unit/p9-3.3.1-audit-asset-integrity.test.ts`
- `tests/unit/p9-3.3.1-audit-wallet-concurrency.test.ts`
- `tests/unit/p9-3.3.1-audit-freshness.test.ts`

命令：

```bash
npx vitest run \
  tests/unit/p9-3.3.1-audit-asset-integrity.test.ts \
  tests/unit/p9-3.3.1-audit-wallet-concurrency.test.ts \
  tests/unit/p9-3.3.1-audit-freshness.test.ts
```

结果：

```text
3 test files
13 tests
8 failed
5 passed
exit code 1
```

### 逐项结果

| 测试 | 结果 | 对应发现 |
|---|---|---|
| `quantity=0` 不得改成 1 | 失败 | F-01 |
| 字符串 boolean 不得转成 false | 失败 | F-01 |
| 非正 item/type/location ID 必须拒绝 | 失败 | F-01 |
| 负数钱包余额必须拒绝并保留旧值 | 失败 | F-07 |
| 角色 A/B 并发同步隔离 | 通过 | - |
| 慢速同角色任务不得回退游标 | 失败 | F-03 |
| 并发成功不得越过另一任务的低 ID 失败 | 失败 | F-02 |
| 幂等重试不得重复证据关联事件 | 失败 | F-05 |
| 游标写入时解绑必须中止 | 失败 | F-04 |
| ESI 响应后所有权变化必须中止 | 通过 | - |
| 行事务内解绑必须回滚 | 通过 | - |
| 游标写失败后下一轮幂等恢复 | 通过 | - |
| 核实/冲正/更正使 FIFO 变 STALE | 通过 | - |

## 全量测试

命令：

```bash
npm test
```

结果：

```text
237 test files
2166 tests
8 failed
2158 passed
exit code 1
```

失败均来自上述独立审计反例，不是测试环境崩溃：

- F-01：3 个资产严格性失败。
- F-07：1 个负数钱包余额失败。
- F-02/F-03/F-04/F-05：4 个同角色并发/事件幂等失败。

因此不能把“大量测试通过”当成 P9.3.3 审计通过。独立审计测试按预期暴露了 P1/P2 缺陷。

## 全量质量门禁

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过（exit 0） |
| `npm run web:check` | 通过（exit 0） |
| `npm run lint` | 通过（exit 0，`--max-warnings 0`） |
| `npm run build` | 通过（exit 0；Vite 提示 chunk >500 kB） |
| `npm run audit:public` | 通过（exit 0） |
| `git diff --check` | 通过（exit 0） |

## 审计覆盖矩阵

| 审计要求 | 证据 | 结论 |
|---|---|---|
| 能力快照缺失/过期 | `p9-3.3-evidence.test.ts:196-227` | 通过 |
| 缺少钱包 scope | 服务/路由测试 | 通过 |
| 角色切换、解绑、所有权变化 | 路由/独立并发测试 | 部分通过；F-04 |
| 同角色并发游标 | 独立并发测试 | 失败；F-02/F-03 |
| 不同角色并发隔离 | 独立并发测试 `:125-159` | 通过 |
| 低 ID 失败不越游标 | 单任务测试通过；并发反例失败 | 不满足验收 |
| 分页超限/空页/截断 | 服务/路由测试 | 通过 |
| 重复导入实体幂等 | 实体数量和关联数量通过 | 部分通过；F-05 事件不幂等 |
| 钱包字段严格类型 | 既有测试 | 通过 |
| FIFO A-E 场景 | `p9-3.3-fifo.test.ts` | 通过 |
| freshness | 既有 + 独立测试 | 服务层通过；F-06 前端不全 |
| 钱包异常余额 | 字符串通过；负数失败 | 部分通过；F-07 |
| `character-sync` 资产异常 | 全批验证测试 | 通过 |
| P9.2 `RealAssetSyncService` 严格性 | 独立测试 | 失败；F-01 |
| REAL/PAPER/AI actor/账本约束 | P9.3 hardening/accounting | 通过（代码 + 隔离测试） |
| ESI GET-only | `esi-security.ts` + 调用链 | 通过（代码验证） |

## 测试限制

1. 并发测试是单进程异步并发，不是多进程 SQLite 锁竞争。
2. `fetch` 和 ESI 响应是模拟对象，不是真实 ESI 网络。
3. 未验证真实 Token 刷新、限流、超时和 ETag 组合。
4. 未运行浏览器 E2E，只做组件源码和 API 契约检查。
5. 费用修改触发 freshness 未找到专门独立测试；相关事件路径仅通过源码推断。
6. 没有连接真实生产数据库，也没有执行迁移。