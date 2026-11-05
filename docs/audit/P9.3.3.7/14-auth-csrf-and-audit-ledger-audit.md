# 14 Auth、CSRF 与审计账本审计

## CSRF/会话边界

- 变更型 P9.3 路由使用 `requireMutationSession()`，测试通过时提供了有效 session、origin 和 CSRF token。
- 读写路由在本轮专项中均实际走 Fastify 路由注入，而非只调用服务函数。
- `logs/p9337-expanded-audit.log` 包含路由级反例。

## 发现

CSRF 检查不能替代对象级授权。F-P9337-01 中：

- 新 owner B 的 session 和 CSRF 都是有效的；
- 请求因此通过 session/CSRF；
- 但 `real_trade_records`、`real_trade_evidence`、`real_trade_events` 仅以 `character_id` 作为查询边界；
- B 仍可读取 A 的资料并成功冲正。

`real_trade_events` 是审计账本，但当前也没有 owner/binding lineage，导致审计历史本身跨 owner 暴露。

## 结论

- 会话/CSRF 基础控制未发现直接绕过。
- 对象级授权存在 P0 缺陷。
- 审计账本完整性和可归属性不足。

## 修复建议

- 在 CSRF/session 之后增加强制 object-level authorization。
- 每个 record/evidence/event 查询都绑定 owner lineage。
- 审计事件记录 owner、binding epoch、actor 和 account ownership hash。
- 对跨 lineage ID 直接访问统一返回 404，避免枚举差异。

证据等级：隔离 SQLite + 真实路由（B 级）；真实环境否。
