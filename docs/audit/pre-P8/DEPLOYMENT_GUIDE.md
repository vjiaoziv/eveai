# EVE AI Agent 部署与日常运维手册 (DEPLOYMENT_GUIDE.md)

本手册专为独立运维打造，提供启动、停止、查看日志、数据备份恢复及日常配置维护的全部命令与规范。

---

## 一、关键部署参数总览

| 配置项目 | 实际值 / 路径 | 说明 |
| :--- | :--- | :--- |
| **实际项目目录 (WSL)** | `/home/ubuntu/projects/eveai` | Linux 环境主路径 |
| **实际项目目录 (Windows)** | `\\wsl.localhost\Ubuntu-24.04\home\ubuntu\projects\eveai` | Windows 文件资源管理器路径 |
| **虚拟磁盘物理存储位置** | `D:\WSL\Ubuntu-24.04\ext4.vhdx` | 已迁移至空间充足的 D 盘 |
| **浏览器访问地址** | `http://127.0.0.1:3000` 或 `http://localhost:3000` | 本地纯回环安全访问 |
| **服务监听端口** | `3000` | 仅监听本地 `127.0.0.1` |
| **Git Commit SHA** | `b93bfcf1c11b593531f928e2283834b57569bab0` | 锁定基准稳定提交 |
| **本地分支** | `deploy/eve-ai-agent` | 包含中文化与配置改造的部署分支 |
| **Node.js 版本** | `v22.23.4 (LTS)` | Ubuntu 内置环境 |
| **模型 Provider** | `openai` | OpenAI Responses 官方 API |
| **当前配置模型** | `gpt-4o` (默认可选 `gpt-5.6-sol` / `gpt-6-astra`) | 绝不输出密钥明文 |
| **数据库文件路径** | `/home/ubuntu/projects/eveai/data/eve-agent.db` | SQLite 存储 |
| **SDE 数据文件路径** | `/home/ubuntu/projects/eveai/data/sde` | EVE 官方静态解压数据 |

---

## 二、日常服务控制与运维指令

所有命令均可在 **Windows PowerShell** 中直接执行：

### 1. 启动服务 (前台运行 / 调试)
```powershell
wsl.exe -d Ubuntu-24.04 --exec bash -c "cd /home/ubuntu/projects/eveai && npm start"
```

### 2. 启动服务 (后台静默运行)
```powershell
wsl.exe -d Ubuntu-24.04 --exec bash -c "cd /home/ubuntu/projects/eveai && nohup npm start > app.log 2>&1 &"
```

### 3. 查看实时运行日志
```powershell
wsl.exe -d Ubuntu-24.04 --exec bash -c "tail -f /home/ubuntu/projects/eveai/app.log"
```

### 4. 停止服务
```powershell
wsl.exe -d Ubuntu-24.04 --exec pkill -f "node dist/app.js"
```

### 5. 重启服务
```powershell
wsl.exe -d Ubuntu-24.04 --exec bash -c "pkill -f 'node dist/app.js' || true; sleep 2; cd /home/ubuntu/projects/eveai && nohup npm start > app.log 2>&1 &"
```

---

## 三、数据库备份与灾难恢复

### 1. 备份数据库 (原子快照)
在项目根目录执行以下命令，将在 `data/backups/` 目录中生成带有时间戳的完整备份文件：
```powershell
wsl.exe -d Ubuntu-24.04 --exec bash -c "cd /home/ubuntu/projects/eveai && mkdir -p data/backups && cp data/eve-agent.db data/backups/eve-agent-$(date +%Y%m%d_%H%M%S).db"
```

### 2. 恢复数据库
若需恢复某历史版本，先停止服务，然后覆盖当前数据库：
```powershell
# 1. 停止服务
wsl.exe -d Ubuntu-24.04 --exec pkill -f "node dist/app.js"

# 2. 从备份恢复（替换为您实际要恢复的备份文件名）
wsl.exe -d Ubuntu-24.04 --exec bash -c "cd /home/ubuntu/projects/eveai && cp data/backups/eve-agent-YYYYMMDD_HHMMSS.db data/eve-agent.db"

# 3. 重新启动服务
wsl.exe -d Ubuntu-24.04 --exec bash -c "cd /home/ubuntu/projects/eveai && nohup npm start > app.log 2>&1 &"
```

---

## 四、配置变更与密钥维护

### 1. 修改 API Key 或更换模型
直接通过 Windows 资源管理器或记事本编辑 `.env` 文件：
```powershell
notepad.exe \\wsl.localhost\Ubuntu-24.04\home\ubuntu\projects\eveai\.env
```
修改对应行：
```ini
OPENAI_API_KEY=your-new-key-here
OPENAI_MODEL=gpt-4o
```
保存后，重启服务即可生效。

### 2. 重新授权 EVE 角色
- 浏览器打开 `http://127.0.0.1:3000`。
- 在左侧菜单或个人资料栏中，点击 **“撤回授权”**（或点击“添加飞行员”）。
- 再次点击 **“通过 EVE Online 登录”** 即可重新唤起官方 SSO 进行二次授权。
- 系统将在本地 SQLite 中自动刷新加密的 Refresh Token。

### 3. 项目代码更新
如需拉取上游更新或合并补丁：
```powershell
wsl.exe -d Ubuntu-24.04 --exec bash -c "cd /home/ubuntu/projects/eveai && git fetch origin master && git merge origin/master && npm run build"
```
---

## 五、跨 Agent 平台调用方式 (Codex / Hermes / dsh)

本项目已实现全局 CLI 工具与 Agent 技能规范，您可以在任何终端、脚本、Codex、Hermes 或 dsh 中直接调度 EVE Agent：

### 1. 终端直接运行 (已写入用户 PATH `C:\Users\JIAOZI\bin\eve-agent.cmd`)
```cmd
# 1. 检查 Agent 服务与 SDE 数据状态
eve-agent status

# 2. 0毫秒极速查询物品属性与分类（支持中英文名/数字ID）
eve-agent item "狂怒者级"
eve-agent item "Tritanium"

# 3. 计算战利品/矿石再处理（解体）矿物产出
eve-agent reprocess "狂怒者级"

# 4. 执行本地 SDE 只读 SQL 查询
eve-agent sde "SELECT type_id, name, zh_name FROM sde_types WHERE group_id = 26 LIMIT 5"

# 5. 向 AI 战术副官发起问答咨询（自动调用 SDE/市场/战损工具）
eve-agent ask "盖伦特联邦有哪些主要护卫舰？列举3艘"
```

### 2. 在 Codex / Hermes / dsh 技能中调用
技能文件已安装至：
- `C:\Users\JIAOZI\.codex\skills\eve-agent\SKILL.md`
- `C:\Users\JIAOZI\.agents\skills\eve-agent\SKILL.md`

任何支持技能调度的智能体（Codex、Hermes、dsh）均可自动识别并使用 `$eve-agent` 技能！
