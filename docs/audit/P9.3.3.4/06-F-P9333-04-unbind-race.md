# F-P9333-04：解绑和重绑竞态

## 1. 原缺陷

资产同步只在 ESI 请求前校验角色绑定。用户随后解绑角色，旧请求返回后仍能提交 mirror 和 snapshot。

## 2. 绑定 epoch

迁移新增 `eve_character_binding_epochs(chat_id, character_id, epoch, updated_at)`，并为 `eve_character_links` 安装 insert/update/delete 触发器：

- 首次链接建立 epoch 1；
- 解绑递增 epoch；
- 同一 chat/character 重新链接继续递增；
- update 同时覆盖 OLD 和 NEW 链接身份。

epoch 不替代 SSO ownership；它只把“同一行被删除后重建”变成可观察的身份代际。

## 3. 任务冻结的身份摘要

启动申请时冻结 binding digest，包含：

- characterId、userId、chatId；
- account user ownership；
- owner hash；
- 排序后的 scopes；
- 排序后的链接 chat/user/linkedAt/epoch。

最终提交事务内重新读取同一摘要。只要解绑、重绑、所有权、owner hash、scope 或链接集合变化，摘要不一致，提交失败。

## 4. 线性化语义

提交与解绑都在 SQLite 写事务中竞争角色相关写入：

- **提交先取得写锁**：snapshot 可以先提交；随后解绑生效。最终状态允许是“已提交快照 + 当前已解绑”，因为提交线性化在前。
- **解绑先提交**：epoch 已递增；旧任务随后进入最终事务时摘要不一致，必须失败且不能写 mirror/snapshot。

租约仍有效不等于授权仍有效。即使 lease 行存在，最终提交仍必须通过身份摘要检查。

## 5. 测试证据

| 测试 | 交错 | 结果 |
|---|---|---|
| T15 | ESI 响应期间解绑 | job FAILED，无 snapshot/mirror，lease 释放，通过 |
| T16 | 解绑后立即重绑同一角色 | 旧任务失败，epoch 增长，无写入，通过 |
| T17a/T18 | 解绑先提交，旧任务 lease 仍存在 | 最终提交拒绝，lease 清理，通过 |
| T17b | 提交事务先持锁，解绑等待 | snapshot 先提交，解绑后生效，通过 |
| 历史反例 | fetch 期间解绑 | 通过 |

测试使用真实临时 SQLite WAL 文件、多个连接和独立子进程文件屏障；没有用 sleep 或内存锁决定事务先后。

## 6. 结论

F-P9333-04 在已测单机多连接/多进程场景中修复。真实 EVE 账户的 SSO 解绑、重新授权和生产数据库锁竞争尚未在本轮验证。
