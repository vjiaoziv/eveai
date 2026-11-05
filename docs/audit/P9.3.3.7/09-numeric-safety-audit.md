# 09 Numeric Safety 审计

## 覆盖范围

- 资产 quantity 必须为正安全整数。
- 聚合使用安全整数/BigInt 路径，超过 `Number.MAX_SAFE_INTEGER` 时拒绝，而不是静默舍入。
- canonical hash 和快照 totals 使用经过标准化的数量。
- 钱包交易 `transaction_id`、`type_id`、`quantity`、`location_id`、`unit_price` 的校验由证据服务统一处理。
- `p9-3.3.6-safe-quantity-aggregation.test.ts` 通过。

## 结论

本轮未复现 F-P9335-05，未发现安全整数溢出进入 COMPLETED snapshot 的有效路径。UNKNOWN 不得替换为 0 的既有边界未扩张。

## 未覆盖

- 真实数据库中的历史遗留超大值。
- 生产迁移后的既有脏数据是否会被 fail closed。
- 真实 ESI 返回的极端数值、NaN 字符串和超范围浮点。
- 证据等级：代码验证 + 隔离测试；真实环境否。
