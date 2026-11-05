# 基线与工作区保护

## 1. 仓库基线

| 项目 | 实际值 |
|---|---|
| WSL 仓库 | `/home/ubuntu/projects/eveai` |
| 分支 | `deploy/eve-ai-agent` |
| HEAD | `9e8e8b32d0e065c6d8479140f94662087193279d` |
| HEAD 提交 | `fix(ci): remove prohibited artifacts and correct expiry gate` |

开始前已执行 `git status --short`、`git branch --show-current`、`git rev-parse HEAD`。实际 HEAD、分支与任务书审计基线一致。

## 2. 既有工作区状态

接手时工作区已包含大量未提交内容，不是干净基线。受保护内容包括：

- P9.3 P9.3.3 的钱包、失败队列、FIFO、freshness 和前端状态修改；
- `docs/audit/P9.3.3.1/`、`P9.3.3.2/`、`P9.3.3.3/` 和 `P9.3.3/` 历史审计报告；
- P9.3.3.3 的独立资产竞态反例；
- P9.3.3.1/2 新增的钱包、FIFO、freshness、资产和身份测试；
- 根目录历史文档归档重命名及既有 staged changes。

本轮没有执行：

- `git reset --hard`
- `git clean -fd`
- `git restore .`
- 提交、推送或部署
- 生产数据库迁移或数据清理

## 3. 本轮最小修改范围

核心业务修改集中于：

- `src/assets/asset-sync-service.ts`
- `src/db/migrations.ts`
- `src/eve/esi-client.ts`

新增独立测试与子进程夹具：

- `tests/helpers/p9-3.3.4-asset-child.ts`
- `tests/unit/p9-3.3.4-asset-job-atomicity.test.ts`
- `tests/unit/p9-3.3.4-asset-fencing.test.ts`
- `tests/unit/p9-3.3.4-asset-canonical-hash.test.ts`
- `tests/unit/p9-3.3.4-asset-character-context.test.ts`
- `tests/unit/p9-3.3.4-asset-unbind-race.test.ts`
- `tests/unit/p9-3.3.4-asset-migration.test.ts`

历史反例 `tests/unit/p9-3.3.3-asset-race.test.ts` 保留并强化为确定性交错，没有删除或降低断言。

## 4. 缺陷映射

| 缺陷 | 触发入口 | 修复点 |
|---|---|---|
| F-P9333-01 | `RealAssetSyncService.syncCharacter()` 的非原子 RUNNING 查询和插入 | `acquireOwnership()` + `BEGIN IMMEDIATE` + `idx_real_asset_jobs_one_running` |
| F-P9333-02 | `computeCanonicalAssetHash()` 遗漏语义字段 | 版本化 canonical representation + `canonical_version`/`hash_algorithm` |
| F-P9333-03 | `syncCharacter()` 接受与 pinned ctx 冲突的目标角色 | 入口身份校验、pinned capability、token-character 校验、ESI token 路径绑定 |
| F-P9333-04 | ESI 响应后解绑仍提交 | 绑定 epoch/digest + 最终提交事务内身份复核 |

## 5. 证据边界

基线和工作区保护由 `git status`、`git diff` 和文件保留情况验证。没有把历史未提交修改误报为本轮新修改，也没有用清理工作区的方式取得测试通过。
