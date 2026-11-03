# P9 Architecture

## 数据边界

```text
公共 ESI 市场 GET → market_orders/market_snapshot_regions
                          ↓
              P9OpportunityService.scan
                          ↓
        p9_real_opportunities + original_snapshot_json
                          ↓
                 p9_trade_plans（人工方案）
                          ↓
      用户在 EVE 客户端自行真实成交
                          ↓
       p9_real_trades（manual / esi，幂等）
                          ↓
       p9_inventory_lots + p9_inventory_moves（FIFO）
                          ↓
               实际已实现/未实现盈亏
```

Paper Trading 继续使用 `paper_*`、`p9` 之外的 P8.7 模块，不进入 REAL 汇总。

## 核心模块

| 模块 | 职责 |
|---|---|
| `src/trading/p9-opportunity-service.ts` | 设置、扫描、机会状态、方案 |
| `src/trading/p9-real-portfolio.ts` | 钱包、挂单占用、库存成本与估值 |
| `src/trading/p9-real-trades.ts` | 人工录入、ESI 同步、去重、FIFO、审计 |
| `src/trading/p9-ai-analysis.ts` | 只读确定性数据的 AI 解释 |
| `src/web/p9-routes.ts` | Web API |
| `src/web/p9-ai-routes.ts` | AI 分析 API 与使用量记录 |
| `src/trading/p9-opportunity-worker.ts` | 按角色启用的自动扫描 |

## 主要表

- `p9_scan_settings`
- `p9_real_opportunities`
- `p9_trade_plans`
- `p9_real_trades`
- `p9_inventory_lots`
- `p9_inventory_moves`
- `p9_trade_audit_events`
- `p9_esi_transaction_sync`
- `p9_job_runs`

定义位置：`src/db/migrations.ts:195-401`。

## 状态机

机会：

`NEW → WATCHING/ACTIONABLE → STALE/EXPIRED/REJECTED → ARCHIVED`

方案：

`PLANNED → USER_CONFIRMED → PARTIALLY_EXECUTED → EXECUTED → HOLDING → PARTIALLY_EXITED → CLOSED`

非法跳转拒绝并写入 `p9_trade_audit_events`。

## 计算归属

确定性代码负责订单簿穿透、费用、数量、资金、FIFO 和风险阈值。

AI 只接收结构化 JSON，并被明确禁止重新计算或覆盖结果。