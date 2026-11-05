# REAL/PAPER 隔离与 ESI 只读边界

## 1. ESI GET-only

继续存在两层保护：

- 操作策略拒绝非 GET / 非 read operation。
- 最终 HTTP dispatch 拒绝非 GET 和非 ESI origin。

验证文件：

- `tests/unit/p8-5-6-esi-readonly-gateway.test.ts`
- `tests/unit/capabilities.test.ts`
- `tests/unit/p9-safety-and-ai.test.ts`

未发现新增 POST/PUT/PATCH/DELETE 路径，也未发现跨 origin 或未登记 operation 绕过。

## 2. REAL/PAPER

验证文件：

- `tests/unit/p9-3-real-accounting.test.ts`
- `tests/unit/p8-7-paper-role-isolation.test.ts`
- `tests/unit/paper-routes-isolation.test.ts`

结果：

- 6 文件、31 项全部通过。
- Agent/AI 不得直接修改 REAL 账本。
- 钱包/资产同步不自动核实交易。
- 资产快照不生成成交事实。
- PAPER 与 REAL 绩效和表保持隔离。
- 未放宽财务触发器。
- 未开放订单执行、ISK 转账、资产转移或合同创建。

## 3. 安全发现

尽管 REQUIRED/GET-only 边界保持，F-P9335-02 仍是跨所有者私有历史披露：

- 所有权转移只清 `character_*` legacy tables；
- immutable snapshot/items/changes 和 jobs/valuations/matches 仍按 character_id 可读；
- 新 owner 路由授权通过后能读取旧 owner 的历史。

因此本节“REAL/PAPER 和 GET-only 通过”不等于整体安全审计通过。

## 4. 证据等级

- 代码与隔离测试：已验证。
- 真实 OAuth、生产授权撤销、生产数据库权限和网络边界：未验证。
