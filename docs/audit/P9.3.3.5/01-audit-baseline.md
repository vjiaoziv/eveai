# 审计基线与工作区保护

## 1. 权威仓库

- Windows 入口：`D:\Git\EVE`
- WSL 权威路径：`/home/ubuntu/projects/eveai`
- 分支：`deploy/eve-ai-agent`
- HEAD：`9e8e8b32d0e065c6d8479140f94662087193279d`
- 最近提交：`9e8e8b3 fix(ci): remove prohibited artifacts and correct expiry gate`

## 2. 工作区状态

开始和结束时工作区均存在大量未提交修改和未跟踪测试/审计文件。审计方未执行 `git reset --hard`、`git clean`、`git restore` 或批量覆盖，也未删除历史审计证据。

审计期间新增内容仅为：

- `tests/unit/p9-3.3.5-*.test.ts`
- `tests/helpers/p9-3.3.5-race-child.ts`
- 对 `tests/helpers/p9-3.3.4-asset-child.ts` 的审计支持修正
- `docs/audit/P9.3.3.5/`

未新增业务代码、schema 或 migration 修改。

## 3. 历史报告与测试保留

以下历史目录存在并保留：

- `docs/audit/P9.3.3/`
- `docs/audit/P9.3.3.1/`
- `docs/audit/P9.3.3.2/`
- `docs/audit/P9.3.3.3/`
- `docs/audit/P9.3.3.4/`

历史反例文件，包括 `p9-3.3.3-asset-race.test.ts` 和全部 `p9-3.3.4-asset-*.test.ts`，均保留并在本轮重新运行。

## 4. 与 P9.3.3.4 报告的关系

P9.3.3.4 的协调器主路径修复可被本轮独立测试支持，但“全系统资产同步只有单一所有者和完整 fencing”的扩展结论不成立。原因是 generic `refreshCharacterDatasets` 资产路径仍直接写 `character_assets`。

## 5. 证据等级

- 代码与 schema：已通过源码检查。
- 并发与事务：已通过隔离 SQLite、独立进程和故障注入测试。
- 生产库、生产迁移、真实 EVE 账户、真实 ESI：未验证。
