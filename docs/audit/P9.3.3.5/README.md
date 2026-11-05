# EVEAI P9.3.3.5 第三轮独立对抗性审计

## 最终状态

`P9_3_3_5_AUDIT_FAILED`

真实交易业务状态保持：

`REAL_ACCOUNTING_READY`

未达到、也不得声明：

`REAL_ACCOUNTING_OPERATIONALLY_VERIFIED`

本阶段只进行独立审计、隔离 SQLite/多进程反例测试和报告生成；未修改业务代码、数据库 schema、migration，未提交、推送、部署或写入生产数据库。

## 基线

- 仓库：`vjiaoziv/eveai`
- 分支：`deploy/eve-ai-agent`
- HEAD：`9e8e8b32d0e065c6d8479140f94662087193279d`
- P9.3.3.4 报告与历史测试均保留。
- 工作区存在大量历史未提交修改，审计期间原样保留。

## 结论摘要

| 项目 | 结论 |
|---|---|
| P9.3.3.3 四项历史缺陷 | 在 `RealAssetSyncService` 协调器主路径上已独立验证修复 |
| 新增缺陷 | 4 个 P1、2 个 P2 |
| 最高风险 | 旧所有者/已解绑上下文的 generic asset sync 仍可写入私有资产镜像；所有权转移后新所有者可读取旧快照历史 |
| 全量测试 | 255 文件，2238/2238 通过，0 失败 |
| P9.3 专项 | 27 文件，154/154 通过 |
| 关键并发组 | 7 文件，28/28，连续 5/5 次通过 |
| 五进程任务竞争 | 1/1，连续 5/5 次通过 |
| 镜像 DELETE 后 SIGKILL | 1/1，连续 5/5 次通过 |
| SSE | 5/5 项，连续 5/5 次通过 |
| 质量门禁 | typecheck、web:check、lint、build、audit:public、git diff --check 全部退出码 0 |
| 生产验证 | 未执行 |
| 提交、代码冻结、部署、P9.3.4、P9.4 | 全部禁止 |

## 22 个问题直接回答

1. **P9.3.3.3 的四项缺陷是否全部修复？**
   是，但仅对 `RealAssetSyncService` 协调器主路径成立；generic asset sync 仍可绕开协调器，因此不能扩展为全系统结论。

2. **是否存在新的 P0/P1/P2 缺陷？**
   是。新增 4 个 P1：F-P9335-01、F-P9335-02、F-P9335-03、F-P9335-04；新增 2 个 P2：F-P9335-05、F-P9335-06。

3. **同一角色是否只能存在一个有效同步所有者？**
   否。协调器任务由数据库事务和唯一索引保证单所有者，但 generic `refreshCharacterDatasets(..., ['assets'])` 不获取 job/lease/generation，可成为第二个写入者。

4. **generation 是否严格单调？**
   对协调器任务表是。`MAX(generation)+1` 在领取事务内计算；但 generic 写入不参与该 generation 空间。

5. **旧任务是否可能绕过 fencing？**
   旧的协调器任务不能；generic asset sync 没有 fencing，可绕过。

6. **是否可能覆盖新快照？**
   协调器旧 generation 不能覆盖新 snapshot；但 generic 写入可使 `character_assets` 与 latest snapshot 分叉，去重路径还可能在镜像为空时复用旧 snapshot。

7. **latest 是否始终唯一且一致？**
   latest 由部分唯一索引保证唯一；由于存在 generic 镜像写入和 F-P9335-01 去重行为，latest 不保证与当前镜像一致。

8. **资产镜像与快照是否原子提交？**
   协调器最终事务内是；全系统否，generic sync 单独替换镜像。

9. **canonical hash 是否覆盖全部资产语义字段？**
   是。版本 1 覆盖 P9.2 的 item/type/quantity/location/location type/flag/singleton/blueprint-copy/parent 语义，并区分 null 与已知 boolean，输入顺序不影响 hash。

10. **pinned character 是否全链路固定？**
   协调器路径是；generic asset refresh 没有完整 binding fence，在所有权转移竞态中可使用旧上下文写回，因此全系统否。

11. **bindingVersion 是否能够阻断解绑后的旧任务？**
   能阻断旧 `RealAssetSyncService` 任务，但 generic sync 不受 binding epoch/digest 的最终提交校验保护。

12. **解绑后重新绑定是否仍然安全？**
   否。F-P9335-01、F-P9335-02、F-P9335-03 分别造成镜像/快照一致性、旧历史披露和旧上下文写回问题。

13. **钱包同步原有保护是否保持？**
   相关 12 个专项文件、56 项测试全部通过；租约、失败队列、保守游标、幂等和 FIFO 新鲜度未见回归。F-P9335-06 表明 malformed wallet journal 仍被误报为成功空同步。

14. **REAL/PAPER 隔离是否保持？**
   在 6 个专项文件、31 项测试中保持；未发现本次改动扩大 REAL/PAPER 穿越。

15. **ESI GET-only 是否保持？**
   是。操作策略和最终 HTTP 派发层均有非 GET 拦截；专项 31 项测试通过。

16. **全量测试是否独立通过？**
   是。255 文件、2238 测试通过，0 失败；这不消除独立反例发现。

17. **SSE 是否稳定？**
   是。`perimeter-radar.test.ts` 每次 5/5，连续 5 次通过，且全量测试中也通过。

18. **哪些事项尚未经过生产验证？**
   真实 ESI 响应、真实角色解绑/重绑、生产 SQLite 迁移、生产并发/负载、真实钱包与人工核实闭环、部署均未验证。

19. **是否建议进入代码冻结和提交阶段？**
   否。存在 P1 缺陷。

20. **是否建议进入生产部署？**
   否。

21. **是否允许进入 P9.3.4？**
   否，当前审计失败。

22. **是否允许启动 P9.4？**
   否，当前审计失败。

## 证据等级

- **已通过代码验证**：源码、事务边界、索引、触发器和最终派发策略已复核。
- **已通过隔离 SQLite/独立进程测试验证**：使用临时数据库、独立 Node.js 子进程和确定性屏障。
- **已通过真实环境验证**：无。
- **尚未验证**：真实 ESI、生产数据库、生产迁移、真实账户和真实运营闭环。

## 报告索引

- `01-audit-baseline.md`
- `02-asset-job-atomicity.md`
- `03-generation-and-fencing.md`
- `04-snapshot-atomicity.md`
- `05-canonical-hash.md`
- `06-character-pinning.md`
- `07-binding-version-and-unbind-race.md`
- `08-wallet-sync-regression.md`
- `09-real-paper-and-esi-security.md`
- `10-independent-adversarial-tests.md`
- `11-quality-gates.md`
- `12-production-validation-boundaries.md`
- `13-findings-and-recommendations.md`
