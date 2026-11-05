# EVEAI P8.5.2：投资组合风控与资产负债表对账审计报告 (P8_5_2_PORTFOLIO_AUDIT.md)

**完成日期**: 2026-11-02  
**关联代码**: `src/trading/portfolio-manager.ts`

---

## 一、虚拟资产与真实资产物理隔离

1. **数据源隔离**:
   - 真实角色资产存储于 `character_assets` 与 `character_wallet`。
   - 模拟盘资产存储于 `paper_trading_positions` 与 `paper_trading_accounts`。
   - 绝不混用两种资产进行计算。
2. **在途审批草案锁定 (`inFlightCommittedIsk`)**:
   - 任何处于 `approved` 状态的草案，其资金直接从 `investableCapital` 扣减。
   - 并发审批场景下，后续草案只能基于剩余可用资金池进行限额判定，彻底杜绝超额批准。

---

## 二、组合限额全局累计实施状态

- **单品 15% 上限**:
  已实现“现有仓库库存 + 在途草案 + 本次提议”累计合并计算。
- **品类 30% 上限**:
  通过 SDE `sde_groups` 关联 `category_id`，对工业大类进行全局集中度控制。
- **防强杀 5,000 万 ISK 门禁**:
  高安运输策略单趟严格截断于 5,000 万 ISK，消除重复代码异味。
