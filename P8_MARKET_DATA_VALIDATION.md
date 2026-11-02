# EVEAI P8：市场数据验证与时间一致性报告 (P8_MARKET_DATA_VALIDATION.md)

**完成日期**: 2026-11-02  
**关联代码**: `src/trading/data-center.ts`

---

## 一、时间一致性与跨星域时间戳偏差审查

在跨贸易中心（如吉他 Jita 与杜迪克西 Dodixie、阿玛尔 Amarr）套利场景中，行情数据由 ESI 接口异步分批拉取。

### 1. 历史重大故障分析
- 在草案 `TR-2026-000001` 生成时：
  - 吉他卖单生成于 `2026-11-01 09:49:09 UTC`
  - 杜迪克西买单生成于 `2026-11-01 23:20:09 UTC`
  - 两地时间差高达 **13 小时 31 分钟 (811 分钟)**。
- **问题实质**: 将两组完全脱节的时间切片拼凑为一个即时套利机会，无视十几个小时内市场早已发生的价格抹平与订单成交。

### 2. P8 引入的数据验证门禁
在 `DataCenter.validateTemporalConsistency` 中：
```typescript
const originAgeMin = Math.round(Math.abs(now - originTs) / 60000);
const destAgeMin = Math.round(Math.abs(now - destTs) / 60000);
const skewMin = Math.round(Math.abs(originTs - destTs) / 60000);

return {
  originSnapshotAgeMinutes: originAgeMin,
  destSnapshotAgeMinutes: destAgeMin,
  timestampSkewMinutes: skewMin,
  isStale: originAgeMin > 60 || destAgeMin > 60 || skewMin > maxAllowedSkewMinutes,
  hasDepthMismatch: false,
};
```
- **门禁参数**:
  - 单侧快照寿命不得超过 60 分钟。
  - 两侧时间漂移不得超过 15 分钟（`maxAllowedSkewMinutes = 15`）。
  - 超限直接在管线中标记为 `isStale = true`，评定为 D 级并予以风险否决。

---

## 二、数据质量与异常订单识别规则

为防止散户偶发挂单或恶意“钓鱼”买单诱导算法，P8 建立了三道数据防线：
1. **盘口剩余量截断**: 严禁将深档低价买单剩余量作为高价买单的深度。单笔提议数量严格以顶档实际剩余量为硬上限。
2. **价格偏离度监控**: 偏离该星区历史 30 日均价 $\ge 50\%$ 且数量 $< 5$ 件的订单，判定为高风险异常单。
3. **订单簿完整性**: 必须同时具备真实的买方与卖方订单簿，禁止在单边单据存在时推断对侧价格。
