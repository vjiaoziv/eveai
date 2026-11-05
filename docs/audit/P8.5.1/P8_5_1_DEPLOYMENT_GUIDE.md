# EVEAI P8.5.1：Paper Trading 模拟盘运维部署指南 (P8_5_1_DEPLOYMENT_GUIDE.md)

**完成日期**: 2026-11-02  
**适用环境**: Windows 11 + WSL2 Ubuntu-24.04

---

## 一、模拟盘启动与常用管理命令

### 1. 查看模拟账户状态与仓位
```bash
# 查看虚拟账户资金净值、持仓及策略细分统计
eve-agent paper-status
```

### 2. 启动/重置模拟账户
```bash
# 重置模拟账户（默认初始资金 10,000,000 虚拟 ISK，历史记录保留）
eve-agent paper-reset 10000000
```

### 3. 生成与追踪模拟订单
```bash
# 启动策略扫描并自动将合格的 A/B 级机会载入模拟盘订单
eve-agent scan-haul 0
eve-agent drafts
```

---

## 二、Web 界面访问

在浏览器中打开：
```text
http://localhost:3000/app
```
进入【交易看板】->【模拟盘 (Paper Trading)】标签页：
- 实时观察虚拟现金曲线、冻结担保金、多档撮合变现估值；
- 查阅机会日志清单（含被否决的 D 级机会及否决原因）；
- 查阅挂单中、部分成交与已完成模拟订单。

---

## 三、备份与故障恢复

```bash
# 备份模拟盘数据
cp ./data/eve-agent.db ./data/eve-agent.db.backup_$(date +%Y%m%d_%H%M%S)

# 重启守护服务
pm2 restart eve-agent || npm run start
```
