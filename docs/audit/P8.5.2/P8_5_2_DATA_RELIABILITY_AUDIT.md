# EVEAI P8.5.2：数据源可靠性与网络韧性审计报告 (P8_5_2_DATA_RELIABILITY_AUDIT.md)

**完成日期**: 2026-11-02  
**关联代码**: `src/trading/data-center.ts`

---

## 一、网络韧性与异常降级策略

1. **ESI 缓存与时钟对齐**:
   - 统一基于 `market_snapshot_regions.fetched_at` 计算快照新鲜度，坚决废止使用订单发布时间 `issued`。
   - 超过缓存期 5 分钟直接标记 `isStale = true`，触发管线 D 级一票否决。
2. **HTTP 420 错误与限速熔断**:
   - 请求异常或发生网络超时（10秒）时，`DataCenter.recordStatus` 将对应源标为 `degraded` 或 `offline`。
   - 策略扫描器检测到数据源故障时，阻断生成高风险交易草案。
