# P9 Deployment Guide

## 现有运行方式

开发：

```bash
cd /home/ubuntu/projects/eveai
npm install
npm run setup       # 下载并载入 SDE（已存在时无需重复）
npm run dev
```

生产：

```bash
npm run build
npm run db:migrate
npm start
```

systemd：

```text
deploy/systemd/eveai.service
```

## Worker

服务启动后自动启动：

- `startMarketSnapshotWorker`：公共区域订单快照
- `startMarketHistoryWorker`
- `startMarketAlertsWorker`
- `startP9OpportunityWorker`：每 5 分钟检查角色自动扫描设置

P9 自动扫描默认关闭；只有 `p9_scan_settings.auto_scan_enabled=1` 的角色才执行。

## 迁移

```bash
npm run db:migrate
```

新增 P9 表：

- `p9_scan_settings`
- `p9_real_opportunities`
- `p9_trade_plans`
- `p9_real_trades`
- `p9_inventory_lots`
- `p9_inventory_moves`
- `p9_trade_audit_events`
- `p9_esi_transaction_sync`
- `p9_job_runs`

迁移幂等。

## 健康与日志

- HTTP：`GET /health`
- P9 扫描任务：`p9_job_runs` 或 `/api/web/trading/p9/jobs`
- 服务日志：`journalctl -u eveai`
- ESI/同步错误：角色同步状态和 `p9_esi_transaction_sync`

## 备份与恢复

已有工具：

- `scripts/backup-data-r2.sh`：SQLite 在线一致性备份到 R2
- `scripts/deploy/remote-deploy.sh`：部署前在线备份、健康检查、失败回滚
- `deploy/systemd/eveai.service`：自动重启和优雅停止

SQLite 保持 WAL；不要直接复制正在写入的 `.db` 文件，使用在线 backup。

## 重启验证

```bash
curl -f http://127.0.0.1:PORT/health
```

然后检查：

1. 市场快照状态
2. P9 扫描 job
3. 角色资产/钱包/订单同步
4. REAL/PAPER 页面数据仍分离