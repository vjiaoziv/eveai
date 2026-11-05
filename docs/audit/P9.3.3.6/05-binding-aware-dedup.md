# 05 Binding-Aware 去重

## 旧风险

仅比较 asset hash 会在以下场景错误返回 COMPLETED：

- 当前 mirror 已为空
- mirror 部分缺失
- 解绑/重绑后同一 hash 属于不同 binding
- owner 转移后旧 snapshot 属于旧 owner

## 新条件

只有以下条件全部成立才允许去重：

1. 当前 lineage 完全一致
2. `data_hash` 一致
3. hash algorithm 为 `sha256`
4. `canonical_version` 一致
5. 当前 mirror 与本次完整 rows 一致
6. 旧 snapshot items 与本次完整 rows 一致

## 事务语义

去重分支仍在同一 IMMEDIATE 事务内完成 job COMPLETED 和 lease 释放；完成失败会回滚，不会留下“旧 mirror + 新 COMPLETED job”的矛盾状态。

解绑重绑会使 epoch 变化，即使 user/chat/character 相同，也不会复用旧 epoch 的 dedup 结果。
