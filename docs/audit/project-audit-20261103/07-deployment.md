# 受控部署与生产核验

## 1. 基线

**已通过真实环境验证**

- 仓库：`/home/ubuntu/projects/eveai`
- 分支：`deploy/eve-ai-agent`
- HEAD：`7e65027c65fcfd0b152a73da7ea4db5351f4e7cf`
- 工作区：包含本轮未提交修复和审计文档；没有 reset、checkout 或覆盖既有修改。
- 权威数据库：`data/eve-agent.db`
- 生产服务：`eveai.service`

## 2. 数据库备份

**已通过真实环境验证**

- 路径：`data/backups/eveai-project-audit-20261103T193218Z.db`
- 大小：`1,142,943,744` bytes
- SHA-256：`6b177a3f7922df9016e575382c7e5351d2063f33f22e0ec15064431acface26b`
- 源库和备份均 `quick_check=ok`，外键违规 0。

## 3. 最终构建归档

**已通过真实环境验证**

- 路径：`data/backups/project-audit-dist-final-20261103T201336Z.tgz`
- 大小：`3,860,999` bytes
- SHA-256：`c53de3a924d0bd20cc4e25d6dd7e9069bf0abafe74c8c3d934d3bf3f14ea769a`
- 归档内容：`dist/` 和 `web/dist/`。

最终构建哈希：

```text
0596dbc6ffe1dc411e21df32bfb6c5d3ab2ff941eadc4a13b4c3cc997ab0280d  dist/app.js
1d7449aa80f34981b62f3f6da4c1bbb64756eaea4fa7293088cea42c3a813fb9  dist/web/asset-routes.js
eb1c2a613c839e60a529e308e67ffb7d0e32c555fa92c1859aae4178c98a6fb4  web/dist/assets/index-B1RHFRtu.js
71582b6f10c800fd998fbc693e3a745d9d09a94643cf0a6a25409cbaa4b25c0f  web/dist/assets/index-C2j3Jj-C.css
```

## 4. 重启与服务状态

**已通过真实环境验证**

执行 `sudo systemctl restart eveai.service` 后：

- MainPID：`804492`
- 启动时间：`2026-11-04 04:14:41 CST`
- ActiveState：`active`
- SubState：`running`
- `/health`：HTTP 200
- database：ok
- web_agent_queue：ok，queued/running/stale 均为 0

启动日志显示：

- Database ready
- SDE data 8490 systems loaded
- HTTP server listening on `127.0.0.1:3000`
- market snapshot/history/alerts workers started
- asset-sync worker started
- EVE-KILL durable REST poll attached
- Telegram/Discord disabled，因为没有 token
- Heartbeat disabled，因为没有 push platform

## 5. HTTP 与前端核验

**已通过真实环境验证**

- `/app`：未跟随重定向返回 302，目标 canonical `http://localhost:3000/app`；跟随重定向返回 200。
- `/api/web/session` 未认证返回 200 和 `session:null`，不泄露角色数据。
- `/api/web/trading/p9/real-ledger/overview`：401
- `/api/web/trading/p9/real-ledger/records`：401
- `/api/web/trading/p9/real-ledger/reconciliation`：401
- `/api/web/trading/p9/real-trades`：401
- `/health` 响应包含 CSP、`X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer` 和权限策略。

生产实际 served 的静态资源：

- `/web-assets/assets/index-B1RHFRtu.js`
- `/web-assets/assets/index-C2j3Jj-C.css`

served 文件与本地 `web/dist` 文件 SHA-256 一致。

## 6. 部署后浏览器回归

**已通过真实环境验证**

- 重载后加载最终 bundle，资产页 `STALE` 警告显示且无重复标点。
- `1440×900` 桌面、`1024×768` 平板、`390×844` 移动端完成检查。
- P9.3 七个标签在移动端可横向滚动，最右侧“审计中心”可达。
- 页面无横向溢出；资产标题不再被挤压。
- 浏览器视口已恢复默认值。

## 7. 回滚预案

**尚未验证**

如需回滚，应按以下顺序执行并保留证据：

1. 停止 `eveai.service`。
2. 保留当前数据库和日志，不覆盖新备份。
3. 仅在数据库结构/数据确有问题时，按已核验备份恢复 `data/eve-agent.db`；恢复前再次核验备份 SHA-256 和 `quick_check`。
4. 使用上一个已归档 `dist`/`web/dist` 构建恢复运行目录。
5. 重启服务，核验 `/health`、`/app`、未认证 REAL 路由 401、数据库完整性和 served 静态资源哈希。
6. 记录回滚原因、时间、版本和验证结果。

本轮没有执行回滚，因为最终部署健康检查和只读回归均通过。
