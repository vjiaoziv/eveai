# 10 Lease 心跳与 Fencing

## 设计

每次资产同步在 `BEGIN IMMEDIATE` 中同时获取单调递增 generation、创建 RUNNING job、更新 lease。只有单个 character 的单个 live lease 可以提交。

## 心跳

长任务按明显短于 lease TTL 的周期续期。续期要求精确匹配：

- character_id
- generation
- job_id
- 未过期 lease
- 当前 owner/chat/binding epoch/digest

## 最终 fence

提交事务前再次读取当前 binding、账户 owner hash 和 lease/job generation。解绑、重绑、owner 改变、取消、心跳失败或 SQLITE_BUSY 都会阻止提交，并清理/失败化本次 job。

旧任务不能通过续期或最终提交复活。
