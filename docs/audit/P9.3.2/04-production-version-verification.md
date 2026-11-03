# 生产版本核验

## 1. 代码版本

**已通过真实环境验证**

- 分支：deploy/eve-ai-agent
- HEAD：66ec79831d06c6222746680a889fcd0ff6d6ac1c
- 上一提交：6d78d59ebd5eb2f8afe293e930bd4dcc8ffc8d47
- Git 工作区：clean

## 2. 后端构建版本

**已通过真实环境验证**

- 入口：/home/ubuntu/projects/eveai/dist/app.js
- SHA-256：0596dbc6ffe1dc411e21df32bfb6c5d3ab2ff941eadc4a13b4c3cc997ab0280d
- 新进程 MainPID：71417
- 进程启动时间：2026-11-03 20:19:40 CST
- dist/app.js 构建时间：2026-11-03 20:15:09 CST
- 结论：进程启动晚于构建，使用本次构建产物启动。

## 3. 前端构建版本

**已通过真实环境验证**

- 构建入口：web/dist/index.html
- 主 JS：web/dist/assets/index-Cz9ski5e.js
- 主 JS SHA-256：66a9e517d11df423f96abec6c23c579dcbe500b00e8ac9a0eec1ea3ee7ece2b1
- 主 CSS：web/dist/assets/index-CbkxD6DZ.css
- 构建时间：2026-11-03 20:15:18 CST

## 4. 实际服务页面

**已通过真实环境验证**

- GET http://localhost:3000/app：HTTP 200
- 页面引用：/web-assets/assets/index-Cz9ski5e.js
- 页面引用：/web-assets/assets/index-CbkxD6DZ.css
- 服务返回的主 JS 与本地构建文件哈希一致：
  - 66a9e517d11df423f96abec6c23c579dcbe500b00e8ac9a0eec1ea3ee7ece2b1
- 服务返回的前端 bundle 包含 real-ledger 接口路径。

## 5. REAL 账本路由

**已通过代码验证**

- 新接口基址：/api/web/trading/p9/real-ledger
- 服务端编译产物：dist/web/p9-3-routes.js
- 编译产物包含：const base = /api/web/trading/p9/real-ledger

**已通过真实环境验证**

未认证请求结果：

- /api/web/trading/p9/real-ledger/overview：HTTP 401
- /api/web/trading/p9/real-ledger/records：HTTP 401
- /api/web/trading/p9/real-ledger/reconciliation：HTTP 401
- 旧路径 /api/web/trading/p9/real-trades：HTTP 401

401 证明路由已注册且受会话保护；没有把 401 解释为业务成功。

## 6. 未完成的运行验证

**尚未验证**

- 当前没有可用的已认证浏览器会话，无法在生产 UI 中人工打开 P9.3 REAL 工作台并读取账号数据。
- 未执行真实交易登记、证据核实、FIFO 消耗、已实现盈亏重算或冲正。
- 真实资产工作台的页面标签、登录态和交互流程仍待下一阶段在有权限会话中验证。

## 7. 结论

**已通过真实环境验证**

生产服务正在运行 66ec798 对应的本次构建，后端进程、启动时间、dist 哈希、前端页面引用和 served bundle 哈希一致。
