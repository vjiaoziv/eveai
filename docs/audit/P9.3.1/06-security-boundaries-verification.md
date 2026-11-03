# 安全边界验证报告

## 1. 权限和会话边界

**已通过代码验证**

- P9.3 读接口使用 `requireSession`。
- P9.3 写接口使用 `requireMutationSession`，要求同源 CSRF 与会话。
- 角色由当前会话 `getLinkedCharacter` 解析，所有 SQL 都以 `character_id` 限定，未暴露跨角色 IDOR。
- 交易、证据、证据关系、费用和财务事件的触发器要求同角色关联。

## 2. REAL/PAPER 隔离

**已通过代码验证；已通过隔离测试数据验证**

- `real_trade_records.is_paper` 强制为 0。
- FIFO 重算显式过滤 `is_paper = 0`，并只接受 VERIFIED + VERIFIED。
- P9.3 performance/unrealized 使用 REAL FIFO/REAL 资产表，不读取 PAPER 成交。
- P9 旧 REAL 交易/库存接口已返回 410；前端权威账本切换为 P9.3。
- 旧 P9 AI 分析已改为读取 P9.3 `real_trade_records` 和确定性核算数据。
- 隔离测试验证 PAPER 记录无法插入 REAL 表，AI actor 无法写 REAL 账本。

## 3. AI 写入阻断

**已通过代码验证；已通过隔离测试数据验证**

- `assertHumanActor` 改为允许列表：只接受 `user` 或 `user:<id>`。
- assistant、bot、llm、system、scheduler、esi-wallet-sync 等身份均被拒绝。
- 人类路径由 web 会话用户 id 构造成 `user:<id>`。
- AI 工具表面测试扫描 full 工具集，确认没有 REAL ledger 写入工具。
- AI 分析只读确定性数据，且提示词明确禁止把 USER_REPORTED/PENDING/DRAFT/旧账本说成已核实。

**尚未验证**

- 没有在当前会话发起真实 AI 模型调用来验证模型输出质量；本任务验证的是工具暴露和写入边界，不是模型文本正确性。

## 4. ESI GET-only

**已通过代码验证；已通过隔离测试数据验证**

- ESI 操作策略要求 `method = GET` 且 `toolPolicy = read`。
- HTTP 派发边界对非 GET 和非 ESI origin 再次拒绝。
- P9.3 钱包同步只调用 `get_characters_character_id_wallet_transactions`。
- P9.2 资产同步只调用 `get_characters_character_id_assets`。
- 真实资产/钱包同步路径通过 `callEsiOperation` 进入统一网关，没有发现绕过网络边界的直接 ESI fetch。

**尚未验证**

- 本次没有在真实网络边界发出 ESI 写请求；系统设计上也不存在该路径。
- 真实钱包日志和订单同步未在 P9.3 中做新的网络实测。

## 5. 真实写入边界

**已通过代码验证**

- 本阶段没有自动交易、撤单、转账、合同操作。
- 真实账本只接受人工登记、证据核实和人工冲正/更正。
- ESI 钱包交易同步只做 GET-only 读取和来源记录，不自动核实交易。
- 旧 REAL 交易写接口返回 410。

## 6. 残余风险

- 生产服务进程未重启，当前 live HTTP 仍可能是修复前 dist；这一风险列入 `08-unresolved-risks.md`。
- `FEE_ADJUSTMENT` 独立费用行的业务归属仍需真实样本进一步定口径。
- 真实 SSO scope、钱包日志和订单权限尚未在当前任务中完成真实业务核实。

## 7. 结论

- 权限、REAL/PAPER、AI actor、ESI GET-only 代码边界：**已通过代码验证**。
- 安全边界回归和工具表面：**已通过隔离测试数据验证**。
- 当前生产数据库和 schema 完整性：**已通过真实环境验证**。
- 真实 ESI/钱包/订单/AI 端到端运行：**尚未验证**。