# F-07 钱包余额与角色资料异常响应保护

## 原问题

钱包余额响应不是有效数字时，旧实现可能以 0 代替；负数也可能被认为是有效值，从而覆盖最后有效余额并把同步误报为成功。

## 修复内容

- src/eve/character-sync.ts
  - 钱包余额必须是 JavaScript number、有限且非负。
  - 不接受字符串数字、NaN、Infinity、负数、null、数组或对象。
  - 非 0 的合法钱包余额正常写入；0 仍是合法余额。
  - 非法响应抛出错误，不执行 character_wallet upsert，保留最后有效余额。
  - 数据集状态记录 error，最后成功时间和本次错误状态保持分离。
- 资产响应的完整验证和原子替换同样保护最后有效镜像，详见 F-01。

## 隔离测试

- tests/unit/p9-3.3.2-wallet-balance-integrity.test.ts：2/2 通过。
- tests/unit/p9-3.3-character-sync.test.ts：8/8 通过（含异常余额和畸形资产响应）。
- tests/unit/p9-3.3.1-audit-asset-integrity.test.ts：4/4 通过。
- 覆盖负余额、字符串、NaN/Infinity、零余额恢复、错误状态与 last-known-good 分离。

## 验证结论

- 代码验证：通过。
- 隔离 SQLite 验证：通过。
- 真实 ESI 异常余额/异常资产响应：未执行。
