# 08 Wallet Journal 验证

## 严格验证

钱包日志响应必须是数组。每一行必须是对象，并严格校验：

- `id`：正安全整数
- `date`：可解析日期
- `ref_type`：非空字符串
- `amount`、`balance`：有限数值
- `description`：字符串
- 可选 party/context id：正整数或省略
- `context_id_type`：非空字符串或省略

任一行失败都拒绝整批，不做静默过滤。

## 原子写入

全部行先验证，随后在一个事务中 upsert。日志不可变且以 id 为键，因此采用 upsert，不删除旧历史；合法空数组也不会清空历史。

## 状态分离

`character_sync_state.status/error` 与最后一次成功同步的 `synced_at/rows_synced` 分离。失败时保留上次成功日志和成功时间，只更新错误状态。
