# EVEAI P8.5.2：安全与只读权限深度穿透审计报告 (P8_5_2_SECURITY_AUDIT.md)

**完成日期**: 2026-11-02  
**审计范围**: 全代码库所有 ESI 端点、Agent 工具与 API 接口

---

## 一、物理级只读安全核查 (Scenario R)

对全项目进行了无死角的关键词扫描与抽象语法树（AST）审查：
- **检查命令**: `grep -rn "create_market_order" src/` 等游戏写指令。
- **核查结论**:
  1. `src/agent/tools.ts`: 仅注册了只读 SQL 工具与 SDE 查询工具，**0 写入工具**。
  2. `src/eve/esi-client.ts`: 没有任何向 EVE ESI 提交订单、取消订单、转账、弃置物品的函数实现。
  3. `DraftSystem`: 草案审批（`approved`）仅在本地 SQLite 数据库中翻转状态位，不触发任何外部网络副作用。
  4. 模拟盘 (`PaperTradingSystem`): 纯本地沙盒虚拟撮合，不与真实钱包发生交互。

---

## 二、Token 密文存储与密钥隔离

- ESI OAuth Token 在 `eve_accounts` 表中采用 **AES-256-GCM** 算法加密。
- 12 字节随机 IV 与 16 字节 Auth Tag 分立保存，通过 HKDF-SHA256 派生用途隔离密钥。
- 生产模式下密钥强制从外部环境变量 `AUTH_SECRET_KEY` 注入，杜绝密钥泄露风险。
