# 14 Item-Set 完整性与 Canonical Hash

## 1. 检查目标

验证 asset snapshot 的完整性不能只比较 item count、location count 和 quantity 总量；必须比较规范化后的持久化 item set。

## 2. Canonical 语义

资产规范化包含会影响财务或资产语义的字段，例如：

- `type_id`
- `quantity`
- `location_id`
- `is_singleton`
- `is_blueprint_copy`
- 其他已定义的 semantic fields

非语义原始字段不应改变 hash。不同 item 明细即使聚合总量相同，也必须产生不同 canonical hash。

## 3. 独立测试

测试：`tests/audit/p9-3.3.9/asset-mirror-and-pagination.test.ts:189`。

构造两个：

- item count 相同。
- quantity 总量相同。
- type/location 明细不同的持久化 item set。

结果：

- canonical hash 不同。
- 未被误去重。
- 未被报告为相同或 `COMPLETE` 的一致快照。
- 测试通过。

另由 `asset-pagination-and-fencing.test.ts` 验证旧 generation 的分页不会因 latest 改变而混入新 item set。

## 4. 结论

F-P9337-03 未复现。item-set 完整性在已有 canonical hash 语义和本轮隔离测试范围内有效。

该结论不覆盖 P9.3.3.9 的 F-P9339-01 scope-refresh 缺陷；后者发生在最新快照的 lineage 指针与唯一索引，而不是 item-set hash 计算。

## 5. 证据等级

- 代码验证：已完成。
- 隔离测试数据验证：已完成。
- 真实环境验证：无。
- 尚未验证：生产历史资产的 canonical version 升级、跨版本 hash 兼容策略。
