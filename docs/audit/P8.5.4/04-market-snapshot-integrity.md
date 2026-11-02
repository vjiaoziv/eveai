# EVEAI P8.5.4：行情快照完整性与时效绑定审计报告 (04-market-snapshot-integrity.md)

**完成日期**: 2026-11-02  
**关联代码**: `src/trading/trading-pipeline.ts`, `src/trading/data-center.ts`

---

## 一、订单簿快照哈希绑定 (`marketSnapshotHash`)

为防止管线评估通过后、草案落盘前，底层数据库被恶意篡改或注入虚假盘口，P8.5.4 建立了快照哈希绑定：
```typescript
const snapshotContent = JSON.stringify({
  sells: originBook.sells.slice(0, 3).map(s => ({ p: s.price, v: s.volumeRemain })),
  buys: destBook.buys.slice(0, 3).map(b => ({ p: b.price, v: b.volumeRemain })),
});
const marketSnapshotHash = createHash('sha256').update(snapshotContent).digest('hex').slice(0, 16);
```
- 凭证数字签名直接覆盖 `marketSnapshotHash`。
- 一旦行情发生剧烈重塑或被篡改，原凭证立即失效。

---

## 二、时钟漂移与缓存有效期硬指标

系统强制执行两道时效门禁：
1. **快照时间差门禁**: 两地快照 `fetched_at` 时间差超过 15 分钟，直接判定为 D 级一票否决。
2. **凭证过期门禁**: `expiresAt` 严格设定为签发后 15 分钟，超过即在 `validatePipelineCredential` 中被拦截（`【凭证过期】`）。
