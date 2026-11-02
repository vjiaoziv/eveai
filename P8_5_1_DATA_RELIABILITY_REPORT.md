# EVEAI P8.5.1：数据源可靠性与缓存失效报告 (P8_5_1_DATA_RELIABILITY_REPORT.md)

**完成日期**: 2026-11-02  
**关联代码**: `src/trading/data-center.ts`

---

## 一、ESI 接口缓存与速率限制机制

1. **官方 ESI 缓存模型**:
   - CCP ESI 市场订单端点（`/markets/{region_id}/orders/`）设置了服务端缓存，通常响应头携带：
     - `Date`: 服务器响应时间
     - `Expires`: 缓存失效时间（通常为请求后 5 分钟）
     - `ETag`: 资源版本校验摘要
   - 本地守护进程在 `market_snapshot_regions` 表中记录了每个星域的 `fetched_at` 和 `expires_at`。
2. **熔断与断路器 (Circuit Breaker)**:
   - 当 `now > expires_at + 300,000` (超过缓存到期 5 分钟仍未成功拉取到新快照)，`DataCenter.validateTemporalConsistency` 自动判定该星域数据为陈旧 (`isStale = true`)。
   - 跨区套利扫描在检测到任一端数据陈旧时，直接输出 D 级一票否决，禁止生成任何交易草案。
3. **HTTP 420 错误与限速规避**:
   - ESI 的错误限制（Error Limit）为每分钟最多 100 次错误。
   - 请求客户端内置了 10 秒超时与退避保护，避免触发 CCP 临时封禁。
