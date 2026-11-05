# EVEAI P8.5.3：幂等性防重与载荷一致性审计报告 (P8_5_3_IDEMPOTENCY_CONCURRENCY_AUDIT.md)

**完成日期**: 2026-11-02  
**关联代码**: `src/trading/paper-trading.ts`

---

## 一、幂等键与请求载荷一致性校验

P8.5.2 初版仅对 `idempotency_key` 做了存在性判断，存在潜在语义冲突漏洞：如果调用方重用了同一个幂等键但传递了不同的交易参数，原代码会错误地返回之前已创建的旧订单。

### P8.5.3 严格幂等状态机规则：
1. **同键同参 (Idempotent Hit)**:
   - `idempotencyKey` 相同且 `(typeId, orderType, price, quantity, characterId)` 完全一致。
   - 行为：安全幂等返回原有订单 ID，不发生二次资金冻结，不新增记录。
2. **同键异参 (Idempotent Conflict)**:
   - `idempotencyKey` 相同但任一核心参数不一致。
   - 行为：硬性抛出 409 冲突错误：
     `【幂等冲突】相同 idempotencyKey 不能用于不同参数的订单！已有订单参数: ...`。

---

## 二、对抗性测试实测

在 `tests/unit/p8-5-3-adversarial.test.ts` 中验证：
- 相同参数连续请求 100 次 $\to$ 成功返回相同 `orderId`，数据库中订单数量保持为 1。
- 相同键修改数量（由 100 件改为 200 件） $\to$ 系统精准拦截并返回 `【幂等冲突】` 提示。
- 相同键修改商品（由 34 改为 6675） $\to$ 系统精准拦截并返回 `【幂等冲突】` 提示。
