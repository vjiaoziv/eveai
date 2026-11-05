# 16 发现和残余风险

## 1. 已复现并修复的发现

| ID | 发现 | 修复结果 | 验证 |
| --- | --- | --- | --- |
| F-P9337-01 | 新 owner 可按 character_id 读取/冲正旧 owner REAL 账本 | owner/chat/epoch 持久授权，读写和子查询隔离 | 隔离路由/服务测试通过 |
| F-P9337-02 | 第二 chat lane 可删除第一 lane 资产镜像 | 镜像主键和删除条件加入 lineage | 隔离并发测试通过 |
| F-P9337-03 | 聚合计数相同、item set 不同却 COMPLETE | canonical item-set SHA-256 比较 | 哈希和路由测试通过 |
| F-P9337-04 | 5000+ snapshot detail 静默截断 | total/limit/offset/hasMore/nextOffset | 5001-item 分页测试通过 |
| F-P9337-05 | 新 owner 继承旧 owner 钱包游标 | 游标/lease/failure 按 lineage 隔离，保守推进 | owner/lane 隔离测试通过 |

修复前反例日志：`logs/00-baseline-p9337-reproduction.log`。

## 2. 原始 P9.3.3 目标的完成情况

| 目标 | 状态 |
| --- | --- |
| 钱包同步主动能力快照 | 完成，隔离 mock ESI 验证 |
| 固定目标角色上下文 | 完成，服务/路由/并发验证 |
| 低 ID 失败不越游标 | 完成，失败队列和重试验证 |
| FIFO 已售/未售 UNKNOWN 分离 | 完成，5 个 FIFO 场景验证 |
| 严格钱包字段校验 | 完成，字符串/方向/数值/日期测试 |
| 钱包余额异常保护 | 完成，保留旧值并记录 error |
| 资产镜像完整验证和原子替换 | 完成，异常响应保留旧镜像 |
| 服务/路由/回归测试 | 完成，完整套件和专项套件通过 |
| FIFO 新鲜度 | 完成，证据/冲正/更正/失败重算验证 |
| REAL/PAPER 和 ESI GET-only | 通过回归复核 |

## 3. 残余风险

### 3.1 Legacy ownerless 数据

旧数据未自动认领。若业务需要恢复历史账本，必须人工核对原始证据、时间和归属，并通过受控流程建立 lineage。当前没有专门认领 UI。

### 3.2 真实环境未验证

尚未验证：

- 真实 EVE 账户和 wallet scope；
- 真实 ESI `from_id`/`X-Pages` 分页；
- 真实 OAuth 过期和重授权；
- 真实角色解绑/所有权转移；
- 真实钱包中的费用完整性；
- 真实人工核实进入 FIFO 的闭环；
- 真实生产数据库迁移和恢复。

### 3.3 费用与盈亏完整性

钱包交易不包含完整经纪人费/税费，因此同步记录保持 `feeStatus = UNKNOWN`。即使方向、数量、价格已知，费用完整时也不能把结果描述为完整真实盈亏。

### 3.4 时间新鲜度

历史 SQLite 时间可能是秒级，新事实使用毫秒 ISO。极端同秒变更、主机时钟漂移和多主机写入仍需真实环境监控。

### 3.5 前端

当前活动前端没有消费 snapshot detail 分页；FIFO 面板已有 STALE/knownRealizedPnl 状态展示，但未做真实浏览器视觉回归。

### 3.6 性能

Vite 主 bundle 约 741.43 kB，存在既有 large chunk warning。未在本阶段做性能优化。

### 3.7 独立审计

P9.3.3.9 独立审计尚未执行。不得把本阶段自测当作最终独立保证。

## 4. 风险结论

已知的五个跨 owner/游标/截断缺陷已修复；高风险残余集中在 legacy 数据归属和真实环境未验证，而不是当前代码对隔离事实的确定性处理。

## 5. 最终残余风险校正（取代第 3.5 节的前端缺口描述）

snapshot detail 分页现已由活动 `AssetScreen` 消费，不再是“未实现”的前端缺口：

- API 客户端：`web/src/api.ts:250-255`；
- 活动页面：`web/src/components/AssetScreen.tsx:201-217` 与 `658-720`；
- 后端分页：`src/web/asset-routes.ts:352-396`。

因此当前残余风险只包括：

- 未做真实浏览器视觉回归；
- 未做超大真实快照的前端交互性能验证；
- 未验证真实 EVE 账户、真实钱包、生产迁移和真实人工核实到 FIFO 的运营闭环；
- legacy ownerless 数据仍需人工核对后才能认领。

已知 P9.3.3.7 五项跨 owner/游标/截断缺陷在代码与隔离测试层面均已关闭；没有已复现的未解决 P0/P1。P9.3.3.9 独立审计仍未执行。

最终构建日志 `logs/24-build-final.log` 的主 JS 为 744.95 kB，取代第 3.6 节的旧数值 741.43 kB；large chunk warning 仍为既有性能残余风险。
