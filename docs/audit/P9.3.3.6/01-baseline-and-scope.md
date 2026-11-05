# 01 基线与范围

## 基线核对

- 仓库：`/home/ubuntu/projects/eveai`
- 分支：`deploy/eve-ai-agent`
- HEAD：`9e8e8b32d0e065c6d8479140f94662087193279d`
- 工作区有大量既有未提交修改，全部保留
- 未执行 `reset`、`clean`、`restore`、commit、push 或生产迁移

## 修复范围

- owner/binding lineage 与跨 owner 历史隔离
- generic 资产镜像写入统一
- binding-aware、mirror-aware 去重
- 严格分页元数据与完整快照事务
- 安全整数数量聚合
- wallet journal 严格验证和原子写入
- stale job 回收、租约心跳和旧 generation fencing

## 非目标

- 不开发交易策略
- 不开放真实交易自动执行
- 不改变 REAL/PAPER 隔离
- 不自动核实 REAL 交易
- 不清理历史审计报告或测试
- 不执行生产数据库迁移

## 证据边界

本报告中的“通过”均指代码检查或隔离测试通过，不指真实账号、真实 ESI 或生产环境验证。
