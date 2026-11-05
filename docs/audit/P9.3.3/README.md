# EVEAI P9.3.3 真实钱包同步与财务计算口径加固

## 基线

- 仓库：vjiaoziv/eveai
- 分支：deploy/eve-ai-agent
- 审计基线 HEAD：9e8e8b32d0e065c6d8479140f94662087193279d
- 权威工作目录：/home/ubuntu/projects/eveai
- 本阶段未提交、未推送、未部署、未修改生产数据库。

## 阶段结论

- 代码与隔离测试门禁：P9_3_3_CODE_HARDENED
- 真实交易会计核算准备状态：REAL_ACCOUNTING_READY
- 真实账号、真实钱包、人工核实、FIFO 和盈亏闭环的运行验证：尚未完成
- 不可据此声明：REAL_ACCOUNTING_OPERATIONALLY_VERIFIED

## 最终门禁快照（2026-11-05）

| 命令 | 结果 |
| --- | --- |
| npm run typecheck | exit 0 |
| npm run web:check | exit 0 |
| npm test | 272/272 文件、2344/2344 用例通过，耗时 166.87s |
| npm run lint | exit 0，0 warnings |
| npm run build | exit 0，Vite 转换 237 modules |
| npm run audit:public | Public artifact audit passed |
| git diff --check | exit 0 |

完整测试日志：/tmp/p9333-8-test.log；类型检查、Web 检查、lint、构建和公共产物审计日志分别为 /tmp/p9333-8-*.log。

## 目标与交付范围

1. 钱包同步主动建立能力快照并固定目标角色。
2. 钱包交易严格字段校验、持久失败记录、保守增量游标和分页完整性保护。
3. FIFO 已实现盈亏、胜率与未售出 UNKNOWN 成本分离。
4. 钱包余额严格校验，资产同步适配器委派 P9.2 原子快照协调器。
5. FIFO 结果 CURRENT、STALE、NEVER_CALCULATED 新鲜度。
6. 服务级、路由级、并发和回归测试。
7. 必要的前端过期状态提示。

未新增交易策略、未开放真实交易自动执行、未削弱 REAL/PAPER 隔离。

## 问题复现路径

1. 无能力快照时直接进行私有钱包同步，旧路径可能只得到不可操作的 428。
2. 路由解析角色 A 后，如果服务只传 userId/chatId，执行期间切换活动角色可能导致 ESI、证据和账本角色不一致。
3. 低 transactionId 失败而较高 ID 成功时，旧游标可能越过失败记录。
4. 未售出 UNKNOWN 开放批次曾被混入已实现盈亏判断，错误制造 N/A。
5. 钱包余额异常时旧实现可能写 0；资产更新曾存在先删后逐行过滤的风险。
6. 账本事实变化后，旧 FIFO 结果仍可能被当作当前结果展示。

## 核心修复

| 文件 | 修复 |
| --- | --- |
| src/trading/p9-3-evidence-service.ts | 固定角色上下文、新能力快照、scope 检查、严格标准化、持久失败记录、角色级租约、保守游标、分页全量预检、逐笔事务与幂等重试；钱包同步强制绕过不含所有权维度的 ESI 缓存 |
| src/eve/esi-client.ts | 为受信任快照同步提供 bypassCache 执行边界，同时保留方法、origin、身份和分页保护 |
| src/web/asset-routes.ts | 快照完整性查询读取 hash_algorithm 与 canonical_version；大快照详情分页返回 hasMore/nextOffset，避免完整快照误报 INCONSISTENT |
| src/trading/p9-3-fifo-service.ts | 分离已售 UNKNOWN 消耗与开放 UNKNOWN 批次；修正确定性盈亏、胜率和新鲜度 |
| src/trading/p9-3-types.ts | 增加 FIFO 新鲜度及可确定性统计字段 |
| src/trading/p9-3-ledger-service.ts | 统一账本变更时间，支撑可靠 STALE 判定 |
| src/eve/character-sync.ts | 钱包余额严格校验；资产同步改为委派 RealAssetSyncService |
| src/assets/asset-sync-service.ts | 资产同步信号传播、完整验证、绑定 fencing、镜像与快照原子提交 |
| web/src/components/P93AccountingPanel.tsx | 展示确定/已知部分盈亏和 STALE 警告 |

## 验证分级

- 已通过代码验证：身份固定、能力快照、游标阻断、严格类型、FIFO 口径、资产原子性、ESI GET-only、REAL/PAPER 隔离和财务触发器边界已人工复核。
- 已通过 P9.3.3.7 审计回归：所有权转移后旧缓存不得污染新角色请求，角色隔离游标可从新所有者的较低 transactionId 开始，资产聚合计数相同但明细不同会报告 INCONSISTENT。
- 已通过真实环境验证：无。未使用真实 EVE 账号、真实钱包、生产数据库或生产部署。
- 尚未验证：真实 ESI 分页稳定性、真实 OAuth 失效、真实角色解绑/重绑并发、真实费用完整性、真实人工核实闭环。

## 工作区安全

- 未执行 git reset、clean、commit、push 或部署。
- 未覆盖或清理既有用户修改。
- 未访问或写入生产 REAL 账本。
- 没有把隔离测试写成生产验证。

## 报告索引

- 01-wallet-sync-and-identity.md
- 02-incremental-cursor-integrity.md
- 03-fifo-pnl-semantics.md
- 04-profile-sync-data-integrity.md
- 05-tests-and-quality-gates.md
- 06-security-boundaries.md
- 07-unresolved-risks.md
