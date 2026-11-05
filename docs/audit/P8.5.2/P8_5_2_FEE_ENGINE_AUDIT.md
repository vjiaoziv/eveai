# EVEAI P8.5.2：费用与税率精算模型深度审计报告 (P8_5_2_FEE_ENGINE_AUDIT.md)

**完成日期**: 2026-11-02  
**关联代码**: `src/trading/fee-engine.ts`

---

## 一、三项费用要素的精确解耦

在 EVE 市场中，Upwell 建筑与 NPC 空间站的计费逻辑有本质区别，必须严防重复征税：

### 1. Upwell 建筑计费结构
- **建筑服务费 (Structure Owner Fee)**: 由玩家所有者在建筑服务中配置（如 1.0%）。
- **统合部法定附加税 (SCC Surcharge)**: 法定硬性征收 **0.5%**。
- **销售税**: 统一按玩家 Accounting 技能折让后的比率征收。
- **审计验证**: 系统已将建筑服务费与 SCC 税独立拆分为 `brokerFeeRate` 和 `sccSurchargeRate`，分别展示与扣除，无重复加收。

### 2. 100.00 ISK 最低费用保底 (Floor Rule)
- 仅当玩家挂出市场订单时适用，立即吃单交易不收取经纪人费，故不触发该保底。
- 小额订单测试（1,000 ISK 挂单，正常 2.1% 仅 21 ISK）实测扣除 100.00 ISK，精准达标。

---

## 二、技能与声望动态关联核查

系统新增 `FeeEngine.getSkillsForCharacter(db, characterId)`：
- 动态查询 `character_skills` 表中 `16622` (Accounting) 与 `3446` (Broker Relations) 的实际等级；
- 避免以 Alpha 3/3 作为一成不变的全局静态假设，确保新手 0 级技能（7.5% 税率）能够获得真实保守的保本测算。
