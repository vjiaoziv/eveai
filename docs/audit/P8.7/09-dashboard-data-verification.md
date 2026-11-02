# P8.7 前端交易分析仪表盘数据核验

## 后端 API

`src/web/trading-routes.ts` 新增：

- `:178` `/api/web/trading/paper/overview`
- `:190` `/api/web/trading/paper/orders`
- `:214` `/api/web/trading/paper/opportunities`
- `:231` `/api/web/trading/paper/fills`
- `:253` `/api/web/trading/paper/performance`
- `:261` `/api/web/trading/paper/runtime-validation`
- `:269` `/api/web/trading/paper/risk`

所有接口均要求 Web 会话，并读取当前关联角色的 Paper 数据。

## 前端页面

`web/src/components/TradingScreen.tsx:87` 提供五个视图：

1. 总览
2. 机会中心
3. 模拟订单
4. 策略绩效
5. 风险面板

入口位于：

- `web/src/App.tsx:581`
- `web/src/components/Sidebar.tsx` 的 `Paper Trading` 导航项

## 数据真实性

页面数据全部来自上述 API：

- 账户、库存、订单、成交、机会：SQLite 实际记录
- 净收益、回撤、成交率：`PerformanceAnalytics` 独立计算
- 运行状态：`PaperTradingRuntimeValidation`
- 综合净利润缺失时显示 `UNKNOWN`
- 零分母指标显示 `N/A`

没有使用前端静态模拟数据冒充真实结果。