# EVEAI 第二轮独立审计：缺陷清单与修复方案 (Defect & Remediation Catalog)

**审计日期**: 2026-11-02  
**缺陷总数**: 12 项 (P0 致命级 7 项，P1 严重级 4 项，P2 改进级 1 项)

---

## 缺陷分类总览

| 编号 | 缺陷名称 | 严重级别 | 影响模块 / 文件 | 状态 |
|---|---|---|---|---|
| **DEF-01** | 跨区套利买单深度错配与虚假价差（Phantom Spread） | **P0 致命** | `src/trading/strategies/regional-hauling.ts` (L84-110) | 待修复 |
| **DEF-02** | 销售税基础税率硬编码错误（8.0% vs 7.5%） | **P0 致命** | `src/trading/fee-engine.ts` (L3, L37) | 待修复 |
| **DEF-03** | 在途已审批草案未扣减投资可用资金（并发超额投资漏洞） | **P0 致命** | `src/trading/portfolio-manager.ts` (L68-75) | 待修复 |
| **DEF-04** | 品类 30% 持仓上限与低流动性风控在验证时被完全忽略 | **P0 致命** | `src/trading/portfolio-manager.ts` (L106-114) | 待修复 |
| **DEF-05** | 单品 15% 持仓上限未统计仓库已有持仓与在途货物 | **P0 致命** | `src/trading/portfolio-manager.ts` (L106) | 待修复 |
| **DEF-06** | 核心策略完全旁路 `OrderBookSimulator`，缺乏多档位滑点推演 | **P0 致命** | `src/trading/strategies/regional-hauling.ts` (L100) | 待修复 |
| **DEF-07** | 跨星区行情快照时间戳严重脱节（最大相差 13.5 小时） | **P0 致命** | `src/trading/data-center.ts`, `regional-hauling.ts` | 待修复 |
| **DEF-08** | 回测引擎存在严重未来数据泄漏与最理想成交偏差 | **P1 严重** | `src/trading/backtesting/engine.ts` (L78-85) | 待修复 |
| **DEF-09** | 遗漏法定 100 ISK 最低经纪人费与 Upwell 建筑 SCC 附加费 | **P1 严重** | `src/trading/fee-engine.ts` (L45-56) | 待修复 |
| **DEF-10** | 资产净值估算使用失效的静态 SDE basePrice | **P1 严重** | `src/trading/portfolio-manager.ts` (L62) | 待修复 |
| **DEF-11** | 回测引擎指标缺失（无 Sortino、CVaR、资金周转率） | **P1 严重** | `src/trading/backtesting/engine.ts` (L125-145) | 待修复 |
| **DEF-12** | 风控模块代码存在无意义的连续重复判断冗余 | **P2 改进** | `src/trading/portfolio-manager.ts` (L93-104) | 待修复 |

---

## 缺陷逐项详细说明与修复方案

### DEF-01: 跨区套利买单深度错配与虚假价差（Phantom Spread）
- **文件**: `src/trading/strategies/regional-hauling.ts:87`
- **复现**:
  扫描吉他到杜迪克西线路，当杜迪克西存在 2 件 700k 买单，且有 10,000 件 1000 ISK 买单时，系统会推荐买入 29 件吉他 27.5 万的商品，并按 700k 测算全部 29 件的利润，导致实盘巨亏 85%。
- **危害**: 极高。直接导致玩家真实资产严重亏损。
- **修复方案**:
  在 `RegionalHaulingStrategy.scan` 中引入订单簿遍历，获取目标买单价格区间的真实深度，或限制单笔推荐量不得超过 `best_buy` 所在顶档订单量的 80%。

### DEF-02: 销售税基础税率硬编码错误
- **文件**: `src/trading/fee-engine.ts:3`
- **复现**:
  `FeeEngine.calculateRates({ clone: 'alpha', skills: { accounting: 3, ... } })` 输出 0.0536，而当前 EVE Online 官方公式输出 0.05025。
- **危害**: 税率高估 0.335%，保本价计算失准。
- **修复方案**:
  将 `BASE_SALES_TAX_RATE` 从 `0.08` 改为 `0.075`。

### DEF-03: 在途已审批草案未扣减投资可用资金
- **文件**: `src/trading/portfolio-manager.ts:68-75`
- **复现**:
  批准一笔占用 700 万 ISK 的草案后，再次查询 `getCapitalBreakdown`，`investableCapital` 依然保持不变，后续草案仍可占用已被批准的资金额度。
- **危害**: 并发生成草案导致总投资金额穿透 20% 安全现金底线。
- **修复方案**:
  从 `investableCapital` 中扣减 `SELECT COALESCE(SUM(capital_required), 0) FROM trade_drafts WHERE status = 'approved' AND executed_at IS NULL`。

### DEF-04: 品类持仓上限（30%）未在风控中校验
- **文件**: `src/trading/portfolio-manager.ts:106-114`
- **复现**:
  在 `validateTradeRisk` 中，无论单笔交易占用某品类多少资金，该函数从未对品类敞口进行判定，代码中完全缺失对应 if 分支。
- **危害**: 资金过度集中在单一工业原料或单一装备品类，一旦版本改动面临灭顶之灾。
- **修复方案**:
  在 `validateTradeRisk` 参数中加入 `categoryId` 与 `db`，查询当前品类持仓总值，若超过 `categoryCapIsk` 则拒绝放行。

### DEF-05: 单品 15% 上限未累计已有持仓
- **文件**: `src/trading/portfolio-manager.ts:106`
- **复现**:
  角色已持有 14% 的某物品，系统再次生成一笔 14% 该物品的草案，由于单笔交易未超 15%，系统放行，实际持仓达到 28%。
- **危害**: 单品持仓集中度风控形同虚设。
- **修复方案**:
  在校验单品时，查询 `character_assets` 与现有未结订单中该 `typeId` 的市值，与 `proposedCost` 合并后对比 `singleItemCapIsk`。

### DEF-06: 核心策略完全旁路 `OrderBookSimulator`
- **文件**: `src/trading/strategies/regional-hauling.ts:100`, `station-arbitrage.ts:50`
- **复现**:
  策略代码中仅做简单的单价相乘，未使用 `OrderBookSimulator.simulateBuy` 和 `simulateSell` 模拟滑点。
- **危害**: 推荐的所有大额挂单或吃单方案均未考虑市场厚度。
- **修复方案**:
  重构扫描流程，候选集确认后必须由 `OrderBookSimulator` 计算加权买入成本与加权卖出收入。

### DEF-07: 跨星区行情快照时间戳严重脱节
- **文件**: `src/trading/data-center.ts`, `regional-hauling.ts`
- **复现**:
  吉他卖单采集于 09:49，杜迪克西买单采集于 23:20，两者相隔 13.5 小时，系统仍作为有效套利机会输出。
- **危害**: 针对早已不存在或发生剧烈波动的陈旧市场信息做决策。
- **修复方案**:
  比对两地订单的 `issued` 时间戳，超过 30 分钟差异的候选直接降级或剔除。

### DEF-08: 回测引擎存在严重未来数据泄漏
- **文件**: `src/trading/backtesting/engine.ts:78-85`
- **复现**:
  `entryPrice = current.lowest`，`exitPrice = next.average`。
- **危害**: 回测收益严重虚高，诱导实盘投资者盲目乐观。
- **修复方案**:
  改用前一日收盘均价挂单，或按当日最高买价/最低卖价测算保守成交概率。

### DEF-09: 遗漏 100 ISK 最低经纪人费与 Upwell 建筑 SCC 附加费
- **文件**: `src/trading/fee-engine.ts:45-56`
- **复现**:
  计算 1000 ISK 挂单的经纪人费输出 21 ISK，而游戏内最低扣除 100 ISK。
- **危害**: 小额高频交易费率失真。
- **修复方案**:
  使用 `Math.max(100.0, calculatedFee)` 施加保底约束。

### DEF-10: 资产净值估算使用失效的静态 SDE basePrice
- **文件**: `src/trading/portfolio-manager.ts:62`
- **复现**:
  查询角色仓库总估值时，使用了 SDE 中几十年前预设的静态 basePrice。
- **危害**: 投资组合总净值失真数十倍。
- **修复方案**:
  优先使用本地同步的吉他 4-4 市场拆包买单均价进行市值重估。

### DEF-11: 回测引擎指标缺失
- **文件**: `src/trading/backtesting/engine.ts:125-145`
- **复现**:
  回测报告缺乏下行风险指标 Sortino 与极端尾部损失 CVaR。
- **危害**: 无法识别具有肥尾暴亏特征的高风险策略。
- **修复方案**:
  增加下行标准差计算函数，输出 Sortino 与 95% CVaR。

### DEF-12: 风控模块代码存在无意义的连续重复判断冗余
- **文件**: `src/trading/portfolio-manager.ts:93-104`
- **复现**:
  连续两个一模一样的 `if (strategy === 'regional_hauling' && proposedCost > limits.maxHaulingCargoIsk)` 分支。
- **危害**: 代码异味，降低维护性。
- **修复方案**:
  删除重复的代码分支。
