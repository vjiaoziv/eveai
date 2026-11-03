# 数据库备份与恢复检查

## 1. 生产数据库

**已通过真实环境验证**

- 路径：/home/ubuntu/projects/eveai/data/eve-agent.db
- .env 配置：DB_PATH=./data/eve-agent.db
- 服务运行用户：ubuntu
- 服务时工作目录：/home/ubuntu/projects/eveai

## 2. 部署前在线备份

**已通过真实环境验证**

- 备份方式：better-sqlite3 在线 backup
- 备份文件：/home/ubuntu/projects/eveai/data/backups/eveai-p93-2026-11-03T12-16-07-575Z.db
- 文件大小：1137184768 bytes
- SHA-256：fb32ff14642ee47c64f5f23f409d3ebdd66dbc2beaadbb24e4dd6b51268a3e79
- 源数据库 integrity_check：ok
- 备份数据库 integrity_check：ok
- 备份中的 real_trade_records：0
- 备份中的 real_trade_events：0

## 3. 构建产物备份

**已通过真实环境验证**

- 归档：/home/ubuntu/projects/eveai/data/backups/p932-dist-20261103T121931Z.tgz
- 内容：dist/ 与 web/dist/
- 文件大小：3847036 bytes
- SHA-256：c1d583f71c7051c6f0fe7c4211e330f6b1023ac34e490c88ce37b020cea121d1

## 4. 迁移后数据库检查

**已通过真实环境验证**

- integrity_check：ok
- real_trade_records：0
- real_trade_events：0
- real_trade_evidence：0
- real_fifo_lots：0
- real_fifo_consumptions：0
- real_asset_snapshots：1
- real_asset_valuations：1

## 5. 财务约束检查

**已通过真实环境验证**

- 财务 trigger 数量：16
- 关键 trigger：
  - real_trade_records_no_delete
  - real_trade_records_immutable_facts
  - real_trade_records_insert_unverified
  - real_trade_records_verify_matching_evidence
  - real_trade_records_verify_conflicts
  - real_trade_events_append_only_update
  - real_trade_events_append_only_delete
  - real_trade_evidence_verified_immutable_update
  - real_trade_evidence_verified_immutable_delete
- 4 个显式 FIFO 索引：
  - idx_real_fifo_consumptions_lot
  - idx_real_fifo_consumptions_sell
  - idx_real_fifo_consumptions_unique_consumption
  - idx_real_fifo_lots_fifo

## 6. 恢复策略

**已通过代码验证**

如服务启动或迁移失败：

1. 停止 eveai.service。
2. 从 data/backups/ 中恢复部署前数据库备份。
3. 从构建产物归档恢复 dist/ 和 web/dist/。
4. 重启服务并检查 /health、日志和数据库 integrity_check。
5. 不删除数据库，不覆盖原始交易历史。

## 7. 结论

**已通过真实环境验证**

部署前备份、在线完整性检查、迁移后完整性检查和财务约束检查均通过。未发生需要执行恢复的故障。
