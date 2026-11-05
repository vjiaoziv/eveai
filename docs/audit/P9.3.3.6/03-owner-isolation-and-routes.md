# 03 Owner 隔离与路由覆盖

## 统一谓词

`assetLineagePredicate()` 同时匹配 user、chat、epoch、digest，并应用于资产读取和派生写入。

## 覆盖面

- 快照列表与详情
- 快照 items、子项和 compare 数据
- asset changes
- jobs 与同步状态关联
- inventory mirror
- valuations
- opportunity matches
- tags
- P9 资产投影
- profile 资产投影与详情

## 详情绕过检查

详情接口不能仅凭 `snapshotId`、`valuationId`、`matchId` 或 child row id 直接读取；必须先通过带 lineage 条件的父快照或父记录授权。P9.3.3.6 的 owner-lineage 测试覆盖有效父记录和伪造 child id 两类路径。

## 路由/RBAC

路由继续使用现有用户/角色所有权上下文，不修改 SSO 所有权隔离机制。服务层再次施加 lineage 条件，形成路由授权 + 服务层数据边界双重保护。
