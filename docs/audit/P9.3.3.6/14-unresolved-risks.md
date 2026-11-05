# 14 未解决风险

## 尚未真实验证

- 真实 EVE 账号的资产 scope 授权和 token 角色匹配
- 真实 ESI 分页、限流、部分失败和 ETag 行为
- 生产数据库上 owner-lineage migration 的耗时、锁竞争和回滚演练
- 真实钱包交易的人工核实、FIFO 和盈亏运营闭环
- 多实例生产部署下的 lease/心跳数据库压力

## 设计性风险

- 无法证明 lineage 的 legacy 资产记录默认不可见，需要后续显式对账才能归属
- SQLite 写锁竞争会拒绝同步而不是冒险提交；需要结合生产负载观察
- 资产完整性依赖 ESI `X-Pages` 与响应结构；上游异常会失败关闭而非返回部分快照

## 证据结论

当前只能讨论代码加固和隔离测试结果，不能声明 `REAL_ACCOUNTING_OPERATIONALLY_VERIFIED`。下一阶段应由独立会话执行 P9.3.3.7 对抗性审计。
