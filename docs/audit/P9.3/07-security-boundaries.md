# P9.3 安全边界与权限审计报告

## 权限边界

- Web 写接口使用 `requireMutationSession` 和同源 CSRF；读取使用 `requireSession`。
- 所有接口按当前会话关联角色隔离，禁止 IDOR 访问其他角色账本。
- 服务层写入调用 `assertHumanActor`，AI、agent、model、automation actor 被拒绝。
- 没有向 AI 工具注册任何真实账本写入能力；AI 只能通过用户发起的分析/读取流程解释数据。
- ESI 保持 GET-only。P9.3 钱包同步仅调用 `get_characters_character_id_wallet_transactions`。
- REAL 账本 `is_paper` 检查约束强制为 0；PAPER 记录不能进入 REAL 表。
- 已核实记录、财务事件和已核实证据由 SQLite 触发器阻止静默修改/删除。

## 数据安全

- 证据保存哈希和最小元数据，不保存原始令牌、refresh token 或 OAuth 材料。
- API 错误不返回数据库路径、凭证或内部堆栈。
- 源数据、计算结果和审计事件分离；派生 FIFO 可重算，原始事件不可覆盖。

## 已验证

- 单元测试验证 AI actor 拒绝、PAPER 写入拒绝、已核实记录删除/数量覆盖被触发器阻断。
- `P93AuditService.integrityCheck` 检查 SQLite integrity_check、6 个审计触发器和 REAL/PAPER 标记。