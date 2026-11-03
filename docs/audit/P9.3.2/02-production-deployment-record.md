# 生产部署记录

## 1. 部署前状态

**已通过真实环境验证**

- 服务：eveai.service
- 状态：active (running)
- 旧 MainPID：27526
- 旧启动时间：2026-11-03 17:00:19 CST
- 数据库：./data/eve-agent.db
- 旧 dist/app.js SHA-256：0596dbc6ffe1dc411e21df32bfb6c5d3ab2ff941eadc4a13b4c3cc997ab0280d

## 2. 质量门禁

**已通过隔离测试数据验证**

- npm run check：通过
- Test Files：225/225 passed
- Tests：2081/2081 passed
- ESLint：0 errors, 0 warnings

**已通过代码验证**

- npm run build：通过
- 后端 TypeScript 编译通过
- Web TypeScript 检查通过
- Vite production build 通过

## 3. 数据库部署

**已通过真实环境验证**

- 部署前在线备份完成，详见 03-database-backup-restore-check.md。
- npm run db:migrate：输出 [migrations] Done，退出码 0。
- 迁移后 SQLite integrity_check：ok。
- 迁移后真实账本计数保持为 0，未写入测试交易。

## 4. 服务重启

**已通过真实环境验证**

- 重启命令：sudo systemctl restart eveai
- 新 MainPID：71417
- 新启动时间：2026-11-03 20:19:40 CST
- 启动日志：Starting EVE AI Agent
- 启动日志：Database ready at ./data/eve-agent.db
- 启动日志：HTTP server listening on 127.0.0.1:3000
- 服务状态：active (running)

## 5. 健康检查

**已通过真实环境验证**

- GET /health：HTTP 200
- status：ok
- database：ok
- web_agent_queue：ok
- timestamp：2026-11-03T12:21:23.027Z

## 6. 构建与进程时序

**已通过真实环境验证**

- dist/app.js 构建时间：2026-11-03 20:15:09 CST
- web bundle 构建时间：2026-11-03 20:15:18 CST
- 服务启动时间：2026-11-03 20:19:40 CST
- 结论：新进程启动时间晚于本次构建时间。

## 7. 结论

**已通过真实环境验证**

生产服务已完成受控重启并加载本次构建。HTTP 200 不是唯一证据，还结合了 MainPID 变化、启动时间、构建时间、dist 哈希和实际页面资源哈希进行核验。
