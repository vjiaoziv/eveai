# 07 Owner/Lane 资产隔离

## 1. 历史缺陷复核

F-P9337-02 要求同一角色的不同 chat lane 不互相覆盖 latest snapshot、mirror、changes 和 jobs。

测试：`tests/audit/p9-3.3.9/asset-mirror-and-pagination.test.ts`。

覆盖：

- Owner A lane A 与 Owner B lane B 使用同一 `character_id`。
- lane A 同步后 lane B 同步。
- 再次反向同步。
- 连续 5 轮重复替换。

结果：

- 两个 lane 的 latest snapshot 各自可见。
- 一个 lane 的替换未删除另一个 lane 的 mirror。
- job、changes 和 snapshot lineage 未串线。
- 5/5 轮通过。

结论：F-P9337-02 未复现。

## 2. 稳定 lineage 下的 Fencing

测试：`tests/audit/p9-3.3.9/asset-pagination-and-fencing.test.ts`。

覆盖：

- 分页期间 latest pointer 改变。
- generation 被新任务回收后旧任务继续心跳。
- 两种场景均连续 5 轮重复。

结果：

- 旧分页始终固定到原 snapshot。
- 旧 generation 的心跳续期被拒绝。
- 未发生旧任务覆盖新 snapshot。

## 3. 新发现：scope 刷新导致 lineage 断代

F-P9339-01 不属于“两个 lane 相互覆盖”，而是同一 owner/chat/epoch 的 stored scopes 变化导致 digest 改变：

- 旧 latest snapshot 仍挂在旧 digest。
- 新 digest 查询不到旧 latest。
- 新同步插入新 latest 时触发唯一索引冲突。
- 同步 job 变为 `FAILED`，旧快照和新 mirror 无法按当前 binding 访问。

详见 `13-asset-mirror-atomic-replacement.md` 和 `20-findings-and-remediation-priority.md`。

因此：

- lane 隔离结论通过；
- 同一 lane 的 scope-refresh lineage continuity 失败；
- 总体审计仍为 `P9_3_3_9_AUDIT_FAILED`。

## 4. 证据等级

- 代码验证：已完成。
- 隔离测试数据验证：已完成。
- 真实环境验证：无。
- 尚未验证：真实 EVE SSO scope 刷新频率、真实多用户多 lane 并发。
