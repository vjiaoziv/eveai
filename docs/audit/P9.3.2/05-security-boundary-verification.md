# 安全边界验证

## 1. ESI GET-only

**已通过代码验证**

- ESI 操作策略要求 method = GET 且 toolPolicy = read。
- HTTP 派发边界对非 GET 和非 ESI origin 再次拒绝。
- P9.3 钱包同步只调用只读钱包交易接口。
- P9.2 资产同步只调用只读资产接口。
- 未发现绕过统一 ESI 网关的直接写请求路径。

**已通过隔离测试数据验证**

- P9.3 hardening 测试通过。
- P9 safety/AI 测试通过。

## 2. AI 写入阻断

**已通过代码验证**

- REAL 账本写入只接受人工 actor。
- assistant、bot、llm、system、scheduler、esi-wallet-sync 等身份被拒绝。
- AI 工具表面没有 REAL ledger 写入工具。
- AI 分析只读取 P9.3 确定性账本数据。

**已通过隔离测试数据验证**

- tests/unit/p9-safety-and-ai.test.ts：4/4 passed。
- tests/unit/p9-3-hardening.test.ts：14/14 passed。

## 3. REAL/PAPER 隔离

**已通过代码验证**

- real_trade_records.is_paper 强制为 0。
- FIFO 重算显式过滤 REAL 且只接受已核实记录。
- P9.3 盈亏和未实现盈亏读取 REAL FIFO 和 REAL 资产表。
- 旧 P9 REAL 交易/库存接口返回 410。
- 前端权威账本切换为 P9.3 REAL ledger。

**已通过隔离测试数据验证**

- P9.3 专项：7/7 passed。
- P9.3.1 hardening：14/14 passed。
- P9 safety/AI：4/4 passed。
- 生产数据库没有 PAPER 记录进入 REAL 表。

## 4. 会话与路由保护

**已通过真实环境验证**

- 未认证访问新 REAL 账本 overview、records、reconciliation 均返回 HTTP 401。
- 旧 REAL 路径同样返回 HTTP 401，说明路由存在且先经过会话门禁。
- 未把 401 当作业务功能成功。

## 5. 生产数据库约束

**已通过真实环境验证**

- 16 个财务 trigger 存在。
- 4 个显式 FIFO 索引存在。
- 删除、改写已核实事实、重复证据关联和非草稿费用变更均有数据库层阻止机制。
- SQLite integrity_check：ok。

## 6. 全量质量门禁

**已通过隔离测试数据验证**

- npm run check：225/225 test files passed，2081/2081 tests passed。
- 部署后专项复验：3/3 files passed，25/25 tests passed。

## 7. 尚未验证

**尚未验证**

- 未在已认证生产会话中执行真实钱包同步、订单关联和证据核实。
- 未对真实 ESI 权限不足、分页截断和重复同步做端到端验证。
- 未执行真实 AI 模型调用；本阶段验证的是工具暴露、actor 门禁和写入边界。

## 8. 结论

**已通过代码验证；已通过隔离测试数据验证；已通过真实环境验证**

代码边界、数据库约束、生产路由保护和部署后专项测试均通过。真实外部数据源和人工核实链路仍受真实样本及认证会话限制。
