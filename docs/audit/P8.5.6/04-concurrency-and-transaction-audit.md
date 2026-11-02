# P8.5.6 真实数据库并发与事务审计

## 修复

### 资金竞争

src/trading/paper-trading.ts:createVirtualOrder 使用立即事务和条件式原子扣减：

~~~sql
UPDATE paper_trading_accounts
SET available_cash = available_cash - ?,
    escrow_locked = escrow_locked + ?
WHERE account_id = ? AND available_cash >= ?
~~~

失败时不创建订单，不允许负现金。

### 凭证竞争

src/trading/trading-pipeline.ts:269 使用：

~~~sql
INSERT OR IGNORE INTO consumed_pipeline_credentials ...
~~~

changes!=1 时返回重放阻断。

src/trading/draft-system.ts:37 使用 db.transaction(...).immediate()，避免多个进程生成相同 draftId。

### 订单状态竞争

成交和撤单均在立即事务内重读订单，并以 status+filled_quantity 条件更新，防止成交/撤单双写。

## 测试

tests/unit/p8-5-6-concurrency.test.ts

- L99：8 个进程、80 个订单争抢 1,000,000 ISK。现金和 escrow 均非负，成功订单数与数据库一致。
- L131：10 个进程、每进程 10 次，共 100 次同一凭证消费。1 次成功、99 次重放、1 条 consumption、1 条 draft。

结果：真实多进程 SQLite 并发测试通过。
