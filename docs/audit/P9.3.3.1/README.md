# EVEAI P9.3.3.1 独立对抗性审计报告

## 审计元数据

- 仓库：`vjiaoziv/eveai`
- 分支：`deploy/eve-ai-agent`
- 审计基线 HEAD：`9e8e8b32d0e065c6d8479140f94662087193279d`
- 审计日期：2026-11-04（Asia/Shanghai）
- 审计方式：源码调用链复核、数据库约束复核、独立故障注入、隔离 SQLite 并发/事务测试、质量门禁实跑
- 业务代码修改：无
- 数据库结构/迁移修改：无
- 生产数据库、生产部署、Git commit、Git push：均未执行
- 真实环境验证：未执行

> 本报告不采信 P9.3.3 原有交付结论，只采用当前工作区源码、数据库约束和实际命令输出。

## 最终结论

```text
P9_3_3_1_AUDIT_FAILED
```

P9.3.3 已修复多项关键问题，但没有证明“此前发现的问题全部修复”。独立对抗性测试确认：

- P0：0 项
- P1：2 项
- P2：5 项
- P3：0 项（另有未覆盖项记录于测试限制）

存在 P1，因此必须暂停提交和部署，不允许进入 P9.3.4 或启动 P9.4。

## 缺陷摘要

| 编号 | 等级 | 结论 | 核心问题 |
|---|---|---|---|
| F-01 | P1 | 已确认 | `RealAssetSyncService` 仍会把非法资产数量、字符串 boolean、非正 ID 静默规范化并提交成功快照 |
| F-02 | P1 | 已确认 | 同角色并发同步可让一个成功任务把游标推进到另一个任务未处理失败记录之后 |
| F-03 | P2 | 已确认 | 较慢的同角色同步可把已前进的游标回退 |
| F-04 | P2 | 已确认 | 最终身份检查与游标写入之间存在 TOCTOU，游标写入时解绑角色仍返回成功 |
| F-05 | P2 | 已确认 | 幂等重试已存在证据关联时会重复追加 `evidence_linked` 审计事件 |
| F-06 | P2 | 已确认 | 部分 REAL 盈亏页面未展示 FIFO freshness，STALE/NEVER_CALCULATED 可被展示为当前结果 |
| F-07 | P2 | 已确认 | 角色资料钱包同步接受负数余额并标记成功，覆盖 last-known-good 余额 |

## README 必须回答的问题

1. **P9.3.3 是否真正修复此前发现的全部问题？**
   - 否。钱包角色固定、能力快照、字段严格验证、FIFO UNKNOWN 分离、`character-sync` 钱包/资产保护等核心改动已落地，但同角色并发游标、资产严格性、最终身份事务边界和前端 freshness 仍不满足验收标准。
2. **是否发现新缺陷？**
   - 是。发现 F-01 至 F-07，其中 F-02 与 F-04 直接关系身份/游标数据完整性。
3. **是否存在 P0/P1 问题？**
   - 无 P0；存在 2 个 P1：F-01、F-02。
4. **哪些关键路径已通过独立测试？**
   - 钱包同步主动建立能力快照、固定 characterId、缺少钱包 scope、请求中切换活动角色、响应后解绑/所有权变化、行事务内解绑回滚、单任务保守游标、分页超限/空页、钱包字段严格校验、FIFO UNKNOWN 分离、FIFO 重算哈希稳定、交易核实/冲正/更正后的 STALE、非法字符串钱包余额保护、`character-sync` 资产全批验证、REAL/PAPER 隔离和 ESI GET-only。
5. **哪些问题只能通过真实环境验证？**
   - 真实 ESI 账号的分页/限流/Token 刷新、真实钱包数据与真实资产响应、真实 SQLite 多进程并发和锁等待、生产前端实际渲染与用户交互。本轮均未验证。
6. **是否建议提交和部署？**
   - 不建议。当前独立审计命令退出码为 1，且存在 P1。
7. **是否允许进入 P9.3.4？**
   - 不允许。必须先修复 P1 并重新审计。
8. **当前是否允许启动 P9.4？**
   - 不允许。

## 验证分类

### 已通过代码验证

- 钱包同步在服务内部调用 `getEveCapabilities()`；私有 ESI 调用要求当前上下文存在新鲜快照。
- 钱包请求路径、私有 Token、证据、账本和游标均绑定目标 `characterId`。
- 钱包字段标准化不使用 truthy 转换，`is_buy` 严格要求 boolean。
- FIFO 已实现盈亏只由已售消耗的未知成本决定；开放 UNKNOWN 批次只影响库存成本和资金占用。
- 确定性胜率按 sell record 聚合；任一消耗批次未知则整笔卖出退出确定性统计。
- `character-sync.ts` 对钱包余额执行有限数值检查，并在失败时保留最后成功值。
- `character-sync.ts` 对资产响应全批验证后才在事务内删除旧数据并替换。
- ESI 客户端和底层 HTTP 分派均拒绝非 GET。
- REAL 记录强制 `is_paper = 0`，已核实交易事实、财务事件和证据关联受不可变/只追加约束保护。

### 已通过隔离测试数据验证

- 7 个既有 P9.3/P9.3.3 专项测试文件：78/78 通过。
- 3 个独立审计测试文件：13 项中 5 项通过、8 项失败，失败对应当前确认缺陷。
- 所有测试均使用内存 SQLite；未写入生产 REAL 账本。

### 已通过真实环境验证

- 无。

### 尚未验证

- 真实 ESI 账号和真实钱包数据的端到端同步。
- 多进程/多实例 SQLite 并发锁行为。
- 生产浏览器中的全部 REAL 盈亏页面与兼容 API。
- 真实资产数据的所有 ESI 合法边界组合。
- Scheduler 实际调度和 Agent 运行时动态调用图的穷尽验证。

## 质量门禁实跑结果

| 命令 | 结果 | 说明 |
|---|---|---|
| `npm run typecheck` | 通过，退出码 0 | `tsc --noEmit` |
| `npm run web:check` | 通过，退出码 0 | `tsc -p web/tsconfig.json --noEmit` |
| 既有 P9.3/P9.3.3 专项套件 | 通过 | 7 文件，78/78 测试通过 |
| 独立审计套件 | 失败，退出码 1 | 3 文件，13 项测试，8 失败 / 5 通过 |
| `npm test` | 失败，退出码 1 | 237 文件，2166 项测试，8 失败 / 2158 通过；失败来自独立审计反例 |
| `npm run lint` | 通过，退出码 0 | `eslint src/ web/src/ --max-warnings 0` |
| `npm run build` | 通过，退出码 0 | 有 Vite >500 kB chunk warning，不是构建失败 |
| `npm run audit:public` | 通过，退出码 0 | Public artifact audit passed |
| `git diff --check` | 通过，退出码 0 | 无空白错误 |

## 工作区与审计产物

审计开始前工作区已包含 P9.3.3 未提交修改和测试，本审计未覆盖、重置或清理这些修改。

本轮新增独立审计测试：

- `tests/unit/p9-3.3.1-audit-asset-integrity.test.ts`
- `tests/unit/p9-3.3.1-audit-wallet-concurrency.test.ts`
- `tests/unit/p9-3.3.1-audit-freshness.test.ts`

本轮新增报告：

- `docs/audit/P9.3.3.1/README.md`
- `docs/audit/P9.3.3.1/01-identity-and-concurrency.md`
- `docs/audit/P9.3.3.1/02-wallet-cursor.md`
- `docs/audit/P9.3.3.1/03-fifo-and-pnl.md`
- `docs/audit/P9.3.3.1/04-asset-and-wallet-integrity.md`
- `docs/audit/P9.3.3.1/05-database-and-ledger.md`
- `docs/audit/P9.3.3.1/06-agent-and-permissions.md`
- `docs/audit/P9.3.3.1/07-test-coverage.md`
- `docs/audit/P9.3.3.1/08-findings-and-recommendations.md`

## 最终业务状态

```text
P9_3_3_1_AUDIT_FAILED
REAL_ACCOUNTING_OPERATIONALLY_VERIFIED = 未达成
```

在修复 P1 并通过新的独立复审之前：

- 暂停提交和部署。
- 不允许进入 P9.3.4。
- 不允许启动 P9.4。
- 不得宣称真实交易业务闭环已完成。