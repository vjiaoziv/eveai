# EVEAI P9.3.3.6 修复报告

## 阶段定位

本阶段修复 P9.3.3.5 独立对抗性审计发现的 4 项 P1、2 项 P2 和 2 项 P2 风险。任务是定向修复与回归验证，不是自我验收，不代表生产部署就绪。

- 分支：`deploy/eve-ai-agent`
- 基线/当前 HEAD：`9e8e8b32d0e065c6d8479140f94662087193279d`
- 工作区：保留既有未提交修改；未 commit、未 push、未部署、未执行生产迁移
- 最终状态：`P9_3_3_6_FIXES_COMPLETE`（修复与门禁完成；不是独立审计通过）

## 证据等级

- **代码验证**：代码和静态/单元检查直接证明。
- **隔离数据验证**：隔离 SQLite/测试数据中通过。
- **真实环境验证**：真实 ESI、真实账号或生产数据库验证；本阶段没有。
- **尚未验证**：没有足够证据。

## 目标问题回答

1. **四项 P1 是否全部修复？** 是。代码与 8 个 P9.3.3.6 专项测试文件覆盖 F-P9335-01..04，57/57 通过。
2. **generic asset writer 是否彻底消除？** 是。运行时 `character_assets` 写入集中在 `RealAssetSyncService`。
3. **所有资产镜像写入是否统一经过协调器？** 是。`character-sync.ts` 的资产数据集只作为适配器调用 `RealAssetSyncService.syncCharacter()`。
4. **所有权转移后新 owner 是否无法读取旧 owner 历史？** 是。快照、items、changes、jobs、valuations、matches、tags 和派生投影均按 owner/chat/binding lineage 过滤。
5. **详情接口是否也受到 owner lineage 保护？** 是。详情和子资源查询通过已授权父快照/账本记录施加 lineage 条件。
6. **去重是否验证当前镜像完整性？** 是。必须同时满足 lineage、canonical hash/version、当前 mirror 完整一致、历史 snapshot items 完整一致。
7. **去重是否隔离 binding epoch？** 是。同用户解绑重绑会增加 epoch，旧 hash 不会跨 epoch 去重。
8. **缺失 X-Pages 是否会失败？** 是。缺失直接抛错，不再当作单页成功。
9. **非法分页元数据是否会失败？** 是。非正数、非整数、超出安全整数、X-Pages 收集期间变化和超过页预算均失败。
10. **是否可能产生不完整 COMPLETED snapshot？** 设计上不会：所有页和所有行先完整获取/验证，最终才在一个 `BEGIN IMMEDIATE` 事务中创建 snapshot 并完成 job。
11. **数量汇总是否保证安全整数？** 是。逐行要求正安全整数，并使用 BigInt 汇总，超过 `Number.MAX_SAFE_INTEGER` 即拒绝。
12. **malformed wallet journal 是否会进入 error/retry？** 是。非数组或任一畸形行都会使整批失败，数据集状态进入 error，保留上次成功日志和成功时间。
13. **stale RUNNING job 是否可以自动回收？** 是。scheduled worker 在选角色前执行 stale reclamation；回收失败则 fail closed。
14. **长任务是否具有可靠心跳？** 是。心跳按租约 TTL 的较短周期续期，并在提交前检查心跳失败。
15. **旧任务能否通过续期复活？** 不能。续期同时校验 generation、job_id、owner/binding 和 lease 过期时间。
16. **P9.3.3.1 至 P9.3.3.5 历史反例是否全部通过？** 是。33 个文件、171 项测试本次复跑全部通过。
17. **REAL/PAPER 隔离是否保持？** 是。本阶段没有改变 REAL/PAPER 存储和权限边界。
18. **ESI GET-only 是否保持？** 是。没有增加 ESI 写方法；安全测试覆盖只读网关。
19. **哪些事项尚未经过生产验证？** 真实 ESI 授权、真实资产响应、真实人物绑定、生产数据库迁移、真实钱包交易和运营级账务闭环均未验证。

## 最终状态

所有本阶段修复、专项回归、安全回归和完整质量门禁均已通过，因此本阶段标记为：

`P9_3_3_6_FIXES_COMPLETE`

真实交易业务闭环仍保持 `REAL_ACCOUNTING_READY`。本阶段没有真实账号、真实钱包数据或生产数据库验证，不得声明 `REAL_ACCOUNTING_OPERATIONALLY_VERIFIED`。下一阶段应由独立会话执行 P9.3.3.7 对抗性审计。
