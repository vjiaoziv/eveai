# P9 Trading Workflow

## 日常流程

1. 启动服务，等待市场快照 worker 刷新。
2. 打开“交易工作台 → 机会中心”。
3. 手动点击“立即扫描”，或启用自动扫描。
4. 按净利润、ROI、资金、流动性、风险筛选。
5. 查看四层利润、数据时间、风险和原始快照。
6. 点击“生成交易方案”。
7. 在“交易方案”中人工确认。
8. 用户在 EVE 客户端自行完成真实买卖。
9. 在“真实交易记录”逐笔录入成交，或同步 ESI wallet transactions。
10. 系统幂等去重并重建 FIFO 库存和实际盈亏。
11. 无法确认成本的库存保持 UNKNOWN。
12. 需要时生成 AI 解释或每日报告。

## 幂等

- 人工交易：`clientKey` 在角色内唯一；相同 key 不同参数返回错误。
- ESI 交易：`external_id = esi:{transaction_id}` 唯一。
- 重复导入不产生第二条账目。

## 修改与审计

人工交易允许修改数量、价格、费用、时间、地点、关联和备注。

每次修改保存：

- 修改前 JSON
- 修改后 JSON
- 时间
- 操作者
- 关联 trade/lot/plan ID

ESI 来源记录禁止静默覆盖，避免破坏权威来源。

## 方案状态触发

- 首笔真实成交：`PLANNED → USER_CONFIRMED`
- 买入量不足计划量：`PARTIALLY_EXECUTED`
- 买入达到计划且未退出：`HOLDING`
- 部分卖出：`PARTIALLY_EXITED`
- 卖出达到计划：`CLOSED`

自动推进也写审计事件。