# EVEAI P8.5.3：订单状态机对抗与非法跳转防护审计 (P8_5_3_ORDER_STATE_MACHINE_AUDIT.md)

**完成日期**: 2026-11-02  
**关联代码**: `src/trading/paper-trading.ts`

---

## 一、状态机白名单与终结态防御

在模拟交易订单生命周期中，状态跃迁必须严格单向流转，坚决杜绝状态回退：

```typescript
const VALID_STATE_TRANSITIONS: Record<string, string[]> = {
  'open': ['partially_filled', 'filled', 'cancelled', 'expired'],
  'partially_filled': ['partially_filled', 'filled', 'cancelled', 'expired'],
  'filled': [],    // 终结态：不可跃迁至任何状态
  'cancelled': [], // 终结态：不可跃迁至任何状态
  'expired': [],   // 终结态：不可跃迁至任何状态
};
```

### 防护测试实测断言 (Scenario State Machine):
1. **已成交订单 (`filled`)**:
   - 尝试再次提交撮合 $\to$ 系统返回 `filledQty = 0`，不产生多余扣款与重复持仓 (PASS)。
   - 尝试执行撤单 $\to$ 系统直接返回 `false` 拒绝撤单 (PASS)。
2. **已撤销订单 (`cancelled`)**:
   - 尝试再次触发撮合 $\to$ 状态机校验拦截，阻止死单复活 (PASS)。
3. **超额成交拦截**:
   - 订单需求 100 件，已成交 40 件，后续撮合传入 100 件 $\to$ 算法严格按剩余 60 件截断，累计成交量严格限制为 100 件，禁止超额多充库存。
