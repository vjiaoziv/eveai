# EVEAI P9.3.3.3 第二轮独立对抗性审计

## 最终状态

~~~text
P9_3_3_3_AUDIT_FAILED
~~~

审计基线：

- 分支：deploy/eve-ai-agent
- HEAD：9e8e8b32d0e065c6d8479140f94662087193279d
- 审计日期：2026-11-04（Asia/Shanghai）
- 审计范围：P9.3 钱包同步、游标、FIFO、角色资料同步、资产快照、身份隔离、REAL/PAPER 与 ESI 只读边界
- 生产环境连接：无
- 真实 ESI 钱包/资产数据验证：无
- 真实人工核实与真实 FIFO 盈亏验证：无

本轮只审计，不修改业务代码、不修改数据库结构、不提交、不推送、不部署。新增的独立反例位于：

~~~text
tests/unit/p9-3.3.3-asset-race.test.ts
~~~

## 结论摘要

| 等级 | 数量 | 编号 | 结论 |
|---|---:|---|---|
| P0 | 0 | - | 未发现 |
| P1 | 1 | F-P9333-01 | 资产同步 RUNNING 检查与任务插入不具备跨进程原子性，两个进程可同时成功，旧响应可覆盖新镜像 |
| P2 | 1 | F-P9333-02 | 资产 canonical hash 漏掉 location_type、is_singleton、is_blueprint_copy，变化会被错误去重 |
| P2 | 1 | F-P9333-03 | RealAssetSyncService.syncCharacter() 不拒绝矛盾的 characterId 上下文；当前路由未发现直接可达路径，但服务契约不安全 |
| P2 | 1 | F-P9333-04 | 资产 ESI 响应期间角色解绑后，服务仍提交资产镜像和快照 |

P9.3.3.1 的 7 项缺陷在现有实现与隔离测试范围内均可验证为已修复。没有证据表明上述 4 项新发现由 P9.3.3.2 的补丁直接引入；它们是本轮从当前代码和对抗性场景中确认的残余缺陷。

## README 必须回答的 16 个问题

1. **P9.3.3.1 的 7 项缺陷是否全部真正修复？**  
   是，基于当前源码和隔离测试：F-01 至 F-07 均已有对应实现和回归证据；但这不代表当前代码不存在新的缺陷。

2. **P9.3.3.2 是否引入了新的 P0/P1/P2 缺陷？**  
   未发现证据表明 F-P9333-01/02/03/04 由 P9.3.3.2 直接引入；它们是当前实现中被独立审计发现并稳定复现的残余问题。

3. **是否存在 P0/P1/P2 问题？**  
   存在 1 项 P1、3 项 P2、无 P0。

4. **SQLite 租约是否具备可靠的旧持有者隔离？**  
   钱包同步租约在已测试路径中通过 owner_id、到期条件、身份复核、事务内前后检查及按 owner 释放实现隔离；但没有递增 fencing token、没有续期。未构造出确定性绕过，仍应作为生产风险跟踪。

5. **失败队列能否避免交易永久漏导？**  
   在已测试路径中可以。低 ID 失败会阻塞游标，后续成功不会越过失败边界；重复同步可重试并清理同 ID 失败标记。尚无最大重试次数、退避和永久失败隔离策略，存在积压风险。

6. **游标是否严格单调且与交易持久化一致？**  
   在钱包专项测试范围内是。SQL 使用单调条件，最终边界写入和身份/租约检查处于同一事务；失败时保留旧游标。资产同步任务游标不属于这一结论范围。

7. **资产快照是否具有完整性和原子性？**  
   **否。** 单批次严格验证和事务替换存在，但并发启动没有数据库级单 RUNNING 约束，canonical hash 也不完整，不能满足验收标准。

8. **身份变化是否能够阻断旧任务写入？**  
   钱包同步路径可以：目标角色上下文固定、能力快照和 ESI 参数绑定、持久化前后复核，相关测试通过。资产服务仍存在 F-P9333-03 的矛盾上下文契约缺陷，以及 F-P9333-04 的角色解绑后提交缺陷。

9. **FIFO 新鲜度是否覆盖全部相关接口和页面？**  
   当前专项测试覆盖 compatible overview、ledger、AI consumer 和前端状态；CURRENT、STALE、NEVER_CALCULATED 均有断言。生产环境真实数据尚未验证。

10. **REAL/PAPER 和 ESI 只读边界是否保持？**  
    在源码和隔离测试范围内保持。ESI 目录策略与最终 HTTP 派发层均拒绝非 GET；REAL 记录强制 is_paper = 0，钱包同步不会自动将交易核实进入 FIFO，Agent 不能写 REAL 账本。

11. **哪些路径仅通过隔离测试验证？**  
    钱包租约多连接/多进程、游标失败重试、角色切换、能力快照、分页超限、FIFO UNKNOWN 分离、freshness、余额异常、资产畸形响应、证据幂等、资产竞态和资产解绑竞态。

12. **哪些路径必须进入真实环境才能验证？**  
    生产 SQLite 的 WAL/journal/busy 行为、多 Node 实例部署、真实 ESI 限流和分页、OAuth 远端撤销传播、真实钱包导入、人工核实、真实 FIFO 批次、费用补录、备份恢复。

13. **是否建议提交？**  
    否。当前全量测试因 4 个独立反例失败，且存在已确认 P1/P2，状态为 P9_3_3_3_AUDIT_FAILED。

14. **是否建议部署？**  
    否。禁止部署当前状态。

15. **是否允许进入 P9.3.4？**  
    否。必须先修复 P1/P2 并完成新的独立复审。

16. **是否允许启动 P9.4？**  
    否。

## 质量门禁摘要

| 命令 | 退出码 | 结果 |
|---|---:|---|
| npm run typecheck | 0 | 通过 |
| npm run web:check | 0 | 通过 |
| npm test | 1 | 245 个测试文件，2204 项；244 文件/2200 项通过，1 文件/4 项失败 |
| npm run lint | 0 | 通过 |
| npm run build | 0 | 通过，存在前端 chunk 超过 500 kB 警告 |
| npm run audit:public | 0 | Public artifact audit passed |
| git diff --check | 0 | 通过 |

独立审计测试文件连续 3 次运行均为 1 failed / 4 failed，不是偶发失败。另有一次全量运行中 `perimeter-radar.test.ts` 因 SSE 等待超时失败；该文件隔离连续 3 次通过，记录为负载相关不稳定测试。

## 验证等级声明

- **已通过代码验证：** 钱包身份固定、能力快照、ESI GET-only、游标单调 SQL、FIFO unknown 口径、REAL/PAPER 数据库与服务约束；同时确认资产服务缺少提交前身份复核。
- **已通过隔离测试数据验证：** 上述路径及故障注入；不等同于生产验证。
- **已通过真实环境验证：** 无。
- **尚未验证：** 真实 ESI、真实钱包、真实人工核实、真实 FIFO、生产多进程 SQLite 与部署。

真实交易业务闭环仍为：

~~~text
REAL_ACCOUNTING_READY
~~~

REAL_ACCOUNTING_OPERATIONALLY_VERIFIED 未达成。

## 报告索引

- 01-audit-baseline.md
- 02-sqlite-lease-and-fencing.md
- 03-wallet-cursor-and-failure-queue.md
- 04-asset-snapshot-integrity.md
- 05-identity-and-oauth.md
- 06-fifo-and-freshness.md
- 07-evidence-idempotency.md
- 08-real-paper-and-esi-security.md
- 09-fault-injection-and-recovery.md
- 10-tests-and-quality-gates.md
- 11-production-validation-boundaries.md
- 12-findings-and-recommendations.md
