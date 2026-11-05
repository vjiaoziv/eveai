# 02 Owner/Binding Lineage 设计

## 目标

`character_id` 不是私有资产数据的授权边界。角色解绑、重绑或转移给其他本地用户后，旧数据不能仅凭相同 `character_id` 被新 owner 读取。

## 持久化字段

私有资产数据统一携带：

- `owner_user_id`
- `owner_chat_id`
- `binding_epoch`
- `binding_digest`

覆盖快照、快照 items、changes、jobs、valuations、opportunity matches、tags、inventory mirror 及相关派生投影。

## Binding epoch

`eve_character_binding_epochs` 以 `(chat_id, character_id)` 为主键。链接 INSERT、UPDATE、DELETE 触发器递增 epoch，使“同一用户解绑后重绑”也可观察。epoch 不替代 SSO ownership 校验，而是补充历史隔离边界。

## Binding digest

`readAssetBindingSnapshot()` 同时读取账户 ownership、scope、chat link、linked_at、epoch 和 owner hash，生成稳定 digest。写入和最终提交都重新读取并比较，避免请求过程中所有权或链接发生变化后把旧响应写回。

## Legacy 数据

无法证明所有权 lineage 的旧记录保持 unowned，默认通过应用查询不可见，必须经显式对账后才可归属。该策略刻意选择“不可见”而不是猜测 owner。
