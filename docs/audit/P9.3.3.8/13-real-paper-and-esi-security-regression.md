# 13 REAL/PAPER 与 ESI 安全回归

## 1. REAL/PAPER 隔离

保留的约束：

- REAL 查询带 `is_paper = 0`；
- REAL 表重建时保留 `CHECK (is_paper = 0)`；
- FIFO 只读取已核实 REAL facts；
- reconciliation 和 AI 真实财务上下文只使用 REAL；
- PAPER 结果不能出现在 REAL 盈亏、库存成本或对账中；
- REAL 记录不能被重标为 PAPER；
- 没有将 PAPER 盈利展示为真实盈利。

相关回归：

- `tests/unit/p9-safety-and-ai.test.ts`
- `tests/unit/p9-3.3-fifo.test.ts`
- `tests/unit/p9-3-real-accounting.test.ts`
- `tests/audit/p9-3.3.7/network-and-safety-boundary-audit.test.ts`
- `tests/audit/p9-3.3.8/migration-and-trigger-integrity.test.ts`

## 2. ESI GET-only

`assertEsiHttpDispatch(url, method)` 位于 `src/eve/esi-client.ts` 的网络 dispatch 边界。钱包交易操作声明为只读；`callEsiOperation()` 在 fetch 前验证方法和 URL origin/path。

因此：

- 不能通过直接调用内部 fetch 绕过方法检查；
- 不能将相对 URL 或外部 origin 当作 ESI；
- 不能以 `bypassCache` 绕过 GET-only；
- 未增加 POST、PUT、PATCH、DELETE。

`tests/unit/p9-safety-and-ai.test.ts` 4/4 通过；`tests/audit/p9-3.3.7/network-and-safety-boundary-audit.test.ts` 反例通过。

## 3. 钱包权限

- 钱包服务主动建立 capability snapshot；
- 必须包含 `esi-wallet.read_character_wallet.v1`；
- token 必须绑定固定 characterId；
- scope 缺失时在 fetch 前失败；
- 过期快照重新建立；
- 不依赖用户此前是否使用过其他 ESI 功能。

## 4. 人工确认边界

- ESI 钱包日志仅作为只读证据；
- 交易进入 FIFO 前必须人工核实；
- `P93LedgerService` 的 REAL mutation 要求人工 actor；
- AI、Agent、LLM、Scheduler 没有 REAL 财务写工具；
- Scheduler/worker 只能做只读同步和任务协调，不替代交易确认；
- 订单、成交、资产快照、钱包日志不是同一事实，不能互相自动推断。

## 5. 生产边界

未执行真实交易、下单、资金移动、生产迁移或部署。未使用真实 EVE 凭证。以上安全结论是代码与隔离回归验证，不是生产渗透测试或真实运营验证。
