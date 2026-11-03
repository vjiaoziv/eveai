# P9 Risk Control

## 风险优先级

推荐前先检查：

1. 行情过期
2. 订单深度不足
3. 快照时差过大
4. 费用不完整
5. 跨区物流成本未知
6. 资金超过阈值
7. 库存成本未知
8. 库存无法及时退出
9. 地点覆盖不完整
10. 同步失败

## 风险标记

扫描写入的风险标记包括：

- `DATA_INCOMPLETE`
- `DATA_STALE`
- `SNAPSHOT_SKEW`
- `LOGISTICS_UNKNOWN`
- `STRUCTURE_OR_UNKNOWN_LOCATION`
- `DEPTH_LIMITED`
- `BELOW_MINIMUM`
- `FEE_INCOMPLETE`
- `SNAPSHOT_LOAD_ERROR`

`riskLevel`：

- `BLOCKED`：数据不完整、过期或低于最低利润/ROI
- `HIGH`：物流未知、时差大或多项风险
- `MEDIUM`：单项一般风险
- `LOW`：无附加风险

## 用户参数

可配置：

- 最低净利润
- 最低 ROI%
- 单次最大资金
- 最大行情年龄
- 最大机会数
- 自动扫描与间隔
- 贸易中心白名单

默认值仅用于工程可运行，不宣称实盘最优。

## 风控不可绕过

- 风险状态通过数据库状态机保存。
- AI prompt 明确禁止建议绕过风控。
- AI 只能解释，不能改写 `riskLevel/riskFlags`。
- 风险中心显示风险标记、同步错误和未知成本库存。