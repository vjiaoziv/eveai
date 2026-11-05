# 12 安全边界

## 保持不变的边界

- ESI 仅 GET；未开放 POST/PUT/PATCH/DELETE
- REAL/PAPER 存储和权限隔离未改变
- AI/Agent/LLM/Scheduler 不修改 REAL 财务账本
- 钱包日志同步不等于人工核实交易
- 未知成本不替换为 0
- 未售出 UNKNOWN 不伪装为确定库存成本
- 不创建虚构生产交易样本
- 不因修复放宽数据库财务触发器

## 身份隔离

owner lineage 是服务层授权条件；SSO ownership 校验仍是前置门槛。角色解绑、所有权变化或 binding 变化会中止资产同步与最终提交。

## 数据保护

异常钱包余额、畸形 wallet journal、无效分页、非安全数量以及不完整资产集均失败关闭，保留上一份有效数据。

## 操作边界

本阶段未 commit、push、部署、执行生产迁移或修改生产数据库。真实交易仍必须人工确认和核实。
