# P9 Asset and Inventory

## 已有 ESI 能力复用

P9 不重写角色同步，复用：

- `src/eve/character-sync.ts`
- `src/web/profile-data.ts`
- `src/web/profile-routes.ts`

可同步数据集：

- 钱包余额
- 钱包 journal
- 资产清单和位置
- 角色挂单
- 合约、技能、克隆等既有数据

权限来自 EVE SSO scope；缺少 scope 时状态为 `no_scope`，不伪造数据。

## 资金分类

`P9RealPortfolioService.overview` 返回：

- `availableIsk`：角色钱包余额
- `openOrderEscrow`：角色买单挂单占用
- `knownInventoryCost`：人工或真实交易确认的成本
- `unknownInventoryExitValue`：未知成本库存的深度退出参考
- `otherUnknown`：固定为 `null`

Paper Trading 资金不进入以上字段。

## 库存成本

`p9_inventory_lots` 支持：

- 人工确认批次
- 真实交易派生批次
- Item ID、Type ID、地点、数量
- 成本 `CONFIRMED` 或 `UNKNOWN`
- 取得时间、交易、机会、备注

无法识别采购来源时，`costPerUnit = null`，不自动从市场价推断成本。

## 估值

库存估值逐档消耗买单：

```text
gross = Σ take × bid.price
net = gross × (1 - sales tax - broker fee)
```

深度不足时返回 `depthLimited=true`。

不能用单个最优买价乘全部数量，也不能把 UNKNOWN 成本当作 0。

## ESI 辅助真实交易

`get_characters_character_id_wallet_transactions`：

- GET 只读
- 使用 `transaction_id` 幂等
- 按 `from_id` 游标记录最后交易 ID
- 同步失败写 `p9_esi_transaction_sync.status='error'`

若 ESI 未提供 fee，费用状态标记 UNKNOWN，实际盈亏不假装已确认。