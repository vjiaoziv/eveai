# F-04 钱包同步身份固定与事务原子性

## 原问题

路由先解析角色 A，但服务上下文只传 userId/chatId。若请求执行期间活动角色切换到 B，ESI 客户端可能重新解析活动角色，造成 ESI 请求角色、证据、账本和游标角色不一致。

## 修复内容

- src/web/p9-3-routes.ts
  - 钱包同步将 route-selected characterId 显式传入服务。
  - 非 ok 或非 ok status 统一返回失败；身份/scope 错误映射为 403，ESI 不完整映射为 502，数据错误映射为 422。
- src/trading/p9-3-evidence-service.ts
  - pinnedCtx 固定 characterId、userId、chatId。
  - 每次同步在本地重新建立 getEveCapabilities 快照，校验快照 authenticated 且 characterId 完全一致。
  - 检查 esi-wallet.read_character_wallet.v1，缺失时给出重新授权提示。
  - 每个分页请求前、完整响应后、每条交易事务内、游标事务前后都重新校验角色所有权和租约。
  - ESI 客户端对认证请求使用 Access Token 绑定的角色覆盖 character_id 路径参数；因此路径、Token、证据、REAL 记录和游标必须属于同一角色。
  - 身份检查、账本/证据写入、失败标记、游标更新在同一控制边界内完成；游标事务在写入后再次断言身份，失败则回滚。
- src/eve/esi-client.ts 与 src/eve/sso.ts 未修改，没有削弱既有 SSO 所有权隔离。

## 隔离测试

- 活动角色切换后仍向 pinned 目标角色请求和写入：通过。
- 请求期间解绑角色：中止且不提交游标：通过。
- 响应后所有权变化：中止：通过。
- 单条交易事务内身份消失：记录/证据回滚：通过。
- 能力快照缺失、过期重建、缺少钱包 scope：通过。

## 验证结论

- 代码验证：通过。
- 隔离 SQLite 验证：通过。
- 真实 OAuth 撤销、真实跨设备活动角色切换：未执行。
