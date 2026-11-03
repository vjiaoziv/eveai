# P9.3 总体架构与数据流报告

## 范围

P9.3 在 P9.2 真实资产快照与估值之上新增 REAL 交易账本、证据链、FIFO 成本、盈亏和资产对账。所有模块位于 WSL 权威仓库 `/home/ubuntu/projects/eveai`，未在 `D:\Git\EVE` 复制源码。

## 数据流

1. 用户在 EVE 客户端手动完成真实交易。
2. 用户通过中文工作台登记成交草稿；手动录入默认 `USER_REPORTED`，不等于已核实。
3. ESI 钱包成交同步只使用 GET-only `get_characters_character_id_wallet_transactions`。成交事实可关联 ESI 钱包证据，但交易费用完整性默认 `UNKNOWN`，不会用钱包 ISK 变化猜测费用。
4. 证据中心登记 ESI 钱包日志、市场订单、资产快照、资产变化或人工凭证，并建立 PRIMARY/CORROBORATING/CONFLICTING 关系。
5. 只有 `record_state=VERIFIED` 且 `verification_status=VERIFIED` 的 REAL 记录进入 FIFO 重算。
6. FIFO 服务重建成本批次和消耗记录，保存计算版本、前后哈希和差异摘要。
7. 盈亏服务分别计算已实现、未实现和绩效指标；数据不足输出 `N/A/null`。
8. 对账服务比较 FIFO 库存与 P9.2 最新完整资产快照，只生成差异项和人工复核案例，不自动生成交易。
9. 审计服务读取追加事件、计算版本和完整性检查；数据库触发器阻止已核实事实被静默覆盖或删除。

## 模块

- `src/trading/p9-3-types.ts`：类型、口径、计算版本、AI 写入阻断。
- `src/trading/p9-3-ledger-service.ts`：登记、草稿、证据、核实、驳回、冲正、更正。
- `src/trading/p9-3-evidence-service.ts`：ESI 钱包成交证据同步。
- `src/trading/p9-3-fifo-service.ts`：FIFO、已实现/未实现盈亏、绩效指标。
- `src/trading/p9-3-reconciliation-service.ts`：资产快照对账和异常案例。
- `src/trading/p9-3-audit-service.ts`：审计事件、核算版本、完整性检查。
- `src/web/p9-3-routes.ts`：会话鉴权、IDOR 边界和中文工作台 API。
- `web/src/components/P93AccountingPanel.tsx`：8 类中文页面。

## 验证状态

- 代码级数据流已由单元测试覆盖。
- 真实 ESI 资产/钱包同步尚未在本次执行中取得可披露的真实样本；见测试报告。