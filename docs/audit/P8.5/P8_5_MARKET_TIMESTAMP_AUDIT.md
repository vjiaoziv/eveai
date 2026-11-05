# EVEAI P8.5：市场数据时间戳独立审计报告 (P8_5_MARKET_TIMESTAMP_AUDIT.md)

**完成日期**: 2026-11-02  
**关联代码**: `src/trading/data-center.ts`

---

## 一、必须严格区分的三类时间戳

在 EVE Online 市场数据体系中，必须在架构层面区分三类完全不同性质的时间：

1. **订单创建时间 (`market_orders.issued`)**:
   - 含义：玩家或 NPC 在游戏内首次挂出该订单的时间戳。
   - 寿命：有效订单最长可存续 90 天。
   - **致命误区**: P8 最初版本使用 `o.issued` 比较两地订单时间。如果吉他卖单挂于 20 天前，杜迪克西买单挂于 1 天前，两者的 `issued` 相差 19 天，但两地数据完全可能是 1 分钟前通过 ESI 同时拉取的。反之，若两笔订单恰好同一天发布，但吉他数据是刚才抓取的，杜迪克西数据是 6 小时前抓取的，`issued` 无法反映任何数据时效。
2. **市场快照抓取时间 (`market_snapshot_regions.fetched_at`)**:
   - 含义：本地爬虫/守护服务向 CCP ESI 发起请求并成功保存该星域全量订单的时间戳。
   - 这是**跨星域套利时效性核验的唯一权威标准**。
3. **ESI 缓存过期时间 (`market_snapshot_regions.expires_at`)**:
   - 含义：CCP 服务器 HTTP 响应头 `Expires` 字段，通常为 5 分钟刷新周期。
   - 超过此时间代表 CCP 端已产生新订单，本地快照进入陈旧状态。

---

## 二、P8.5 修正后的时间一致性验证实现

在 `src/trading/data-center.ts` 中重构为：
```typescript
public static validateTemporalConsistency(
  db: Db,
  originRegionId: number,
  destRegionId: number,
  maxAllowedSkewMinutes = 15,
): DataQualityMetrics {
  const now = Date.now();
  const originMeta = this.getRegionSnapshotMeta(db, originRegionId);
  const destMeta = this.getRegionSnapshotMeta(db, destRegionId);

  const originFetchedTs = parseIso(originMeta?.fetchedAt);
  const destFetchedTs = parseIso(destMeta?.fetchedAt);
  const originExpiresTs = parseIso(originMeta?.expiresAt);
  const destExpiresTs = parseIso(destMeta?.expiresAt);

  // 权威时差计算：以两星域采集时间差为准
  const originAgeMin = Math.round(Math.abs(now - originFetchedTs) / 60000);
  const destAgeMin = Math.round(Math.abs(now - destFetchedTs) / 60000);
  const skewMin = Math.round(Math.abs(originFetchedTs - destFetchedTs) / 60000);

  // 严格过期门禁：超过 60 分钟未更新、两地采集时差超过 15 分钟、或超过 ESI 缓存期 5 分钟以上
  const isCacheExpired = (originExpiresTs > 0 && now > originExpiresTs + 300_000)
    || (destExpiresTs > 0 && now > destExpiresTs + 300_000);

  const isStale = !originFetchedTs || !destFetchedTs
    || originAgeMin > 60 || destAgeMin > 60
    || skewMin > maxAllowedSkewMinutes
    || isCacheExpired;

  return {
    originSnapshotAgeMinutes: originAgeMin,
    destSnapshotAgeMinutes: destAgeMin,
    timestampSkewMinutes: skewMin,
    isStale,
    hasDepthMismatch: false,
  };
}
```

---

## 三、测试用例验证 (Case B & Case C)

- **Case B 验证结果 (PASS)**:
  两地订单 `issued` 相差 24 小时，但在 `market_snapshot_regions` 中 `fetched_at` 仅相差 1 分钟。
  测试输出：`quality.isStale === false`，`timestampSkewMinutes === 1`。系统正确判定数据高度同步。
- **Case C 验证结果 (PASS)**:
  两地订单 `issued` 完全相同，但 `market_snapshot_regions` 中 `fetched_at` 是 2 小时前。
  测试输出：`quality.isStale === true`，`originSnapshotAgeMinutes >= 119`。系统正确判定行情陈旧。
