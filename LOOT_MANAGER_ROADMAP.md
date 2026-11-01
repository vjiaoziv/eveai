# EVE AI Agent 库存处置模块规划方案 (LOOT_MANAGER_ROADMAP.md)

模块代号：**Loot Manager（库存处置管理器）**  
定位：基于 EVE ESI 资产快照、SDE 静态解体数据库与区域市场深度订单簿的**纯只读智能分析与处置决策引擎**。

---

## 一、核心原则：严格只读与人工确认

1. **绝对只读红线**：
   - 本模块绝不申请、亦绝不持有任何 ESI 写入权限（如 `esi-fittings.write_fittings.v1`、`esi-ui.write_waypoint.v1` 等）。
   - Agent 严格禁止通过任何程序或接口自动执行游戏内资产操作，包括但不限于：在空间站出售物品、挂牌市场订单、启动再处理/解体、丢弃物品、打包转移或修改舰船装配。
2. **决策交付形态**：
   - 所有分析计算结果仅在浏览器管理面板或聊天界面以**“结构化处置建议报告”**与**“飞行员操作核对清单（Checklist）”**的形式交付，最终操作 100% 由飞行员本人在游戏客户端内手动确认并执行。

---

## 二、资产数据读取与多层容器拓扑建模

### 1. 数据来源与字段映射
从本地同步的 `character_assets` 数据表中提取飞行员全部资产数据：
- `item_id`：EVE 全局资产唯一实体 ID（单件装备与容器具备唯一 ID；堆叠物品具备动态 ID）。
- `type_id`：物品类型 ID，外键关联 `sde_types` 获取中英文官方名称。
- `quantity`：资产数量。
- `location_id`：空间站 Station ID、建筑 Structure ID 或父级容器 `item_id`。
- `location_flag`：位置槽位标识（如 `Hangar`, `Cargo`, `DroneBay`, `HiSlot0`-`7`, `MedSlot0`-`7`, `LowSlot0`-`7`, `RigSlot0`-`2`）。
- `is_singleton`：是否为单件包装/已组装/已变体物品。
- `is_blueprint_copy`：是否为蓝图拷贝（BPC），严禁按原版蓝图（BPO）高价误估。
- `synced_at`：该笔资产在本地数据库落盘的同步时间戳。

### 2. 容器树拓扑解析逻辑
资产并非扁平排列，系统建立多叉树算法解析三层容器：
- **顶级空间站/建筑机库** (`location_type = 'station' | 'structure'`)：作为顶层根节点。
- **舰船容器** (`location_flag = 'Hangar'` 且 `group_id` 为舰船)：
  - 舰船本体挂载装备（`HiSlot`, `MedSlot`, `LowSlot`, `RigSlot`）：归类为“在役配置”，默认保护，不纳入日常刷怪掉落物处置。
  - 舰船货舱与无人机舱（`Cargo`, `DroneBay`）：作为高概率任务战利品暂存区。
- **货柜内部资产** (`location_id` 等于某个货柜的 `item_id`)：
  - 递归解析货柜子节点，清晰标记所属父容器（如“Jita 4-4 机库 -> 强力货柜 -> 掉落物”）。
- **无法解析或异常资产**：若缺少 SDE 对应 `type_id`（新版本道具或绝版物品），统一标记为 `Unknown / Unresolved`，强制归入人工核查分类。

---

## 三、近期新增物品识别（差分快照机制）

### 1. ESI 接口边界客观事实
**明确结论**：EVE ESI 资产接口（`/characters/{character_id}/assets/`）仅返回当前资产的最新状态快照，**底层不包含任何关于物品来源（是否任务掉落、刷怪拾取、生产产出或市场买入）的原生属性或标签**。

### 2. 启发式快照差异分析引擎
Loot Manager 通过以下差分算法识别近期新增战利品：
1. **基线快照建立**：记录任务出航前的资产快照 $S_0$（记录所有 `item_id`、`quantity` 与位置）。
2. **返航差异比对**：在任务归航、空间站靠泊并同步后获取快照 $S_1$：
   - **完全新增条目**：$item\_id \in S_1 \land item\_id \notin S_0$。
   - **堆叠数量增加**：$\Delta quantity = quantity_{S_1} - quantity_{S_0} > 0$（常见于弹药、打捞材料、矿石及常用衍生模块）。
   - **位置变化**：此前位于舰船货舱（`Cargo`），返航后转移至空间站物品机库（`Hangar`）。
   - **时间窗口收敛**：结合当前会话的战斗/任务起止时间，精准筛选近 1~6 小时内产生正向净增的物品集作为候选战利品。

---

## 四、智能物品多级分类体系

对筛选出的资产，结合 SDE 的 `group_id`、`market_group_id` 与属性特征自动分类：
1. **任务物品 (Mission Items)**：标记有 `Mission / Storyline` 属性的非通用物品，通常只能交付任务代理人，提示“保留并交付任务”。
2. **弹药与充能物 (Ammunition & Charges)**：导弹、炮弹、晶体、纳米体修复贴等，根据当前驾驶舰船类型推荐“自用保留”或“折价出清”。
3. **舰船装备 (Modules & Rigs)**：
   - 衍生装备 (Meta 1~4 / Compact / Enduring)：再处理产出矿物与直接出售存在显著价差，进入收益比价引擎。
   - 势力/官员/死亡空间装备 (Faction / Deadspace / Officer)：高价值珍宝，强制建议“保留或在枢纽核心挂单出售”，严禁误点解体。
4. **舰船组件与材料 (Components & Materials)**：用于制造的中间构件。
5. **打捞材料 (Salvage Materials)**：制造改装件（Rigs）的关键原料，体积小单价高，根据吉他买单深度推荐处理。
6. **矿物与同位素 (Minerals & Ice Products)**：重资产，体积庞大，根据本地运力评估“就地卖出”还是“精炼压缩后外运”。
7. **蓝图 (Blueprints)**：明确区分 BPO 与 BPC，检查流程次数、物研等级。
8. **低价值垃圾 (Low-value Junk / Metal Scraps)**：单件价值极低且体积占用大者，归入集中再处理批次。
9. **待核查物品 (Pending Audit)**：市场流动性极差或缺乏公开买单的冷门物品。

---

## 五、精算法：直接出售 vs 再处理收益决策模型

对每件待处理物品，系统同时计算两条处置路径的净收入：

### 路径 A：直接出售净收益 ($R_{sell}$)
$$R_{sell} = \sum (\min(P_{highest\_buy}, P_{spread\_adjusted}) \times Q) \times (1 - T_{tax} - B_{broker})$$
- **行情数据源**：调用本地同步的贸易区真实订单簿（如吉他 Jita 4-4 或当前星域中心）。
- **买单深度校验**：检查当前最高买单的有效收购量是否满足出货数量 $Q$；若深度不足，向下穿透订单簿加权计算真实成交均价，绝不使用虚高的全服统计均价。
- **费用扣除**：扣除角色会计学技能减免后的交易税 ($T_{tax}$) 以及设立订单时的经纪人费 ($B_{broker}$)。

### 路径 B：再处理（解体）净收益 ($R_{reprocess}$)
$$R_{reprocess} = \sum_{m \in Materials} (Q_m \times P_{buy\_m}) \times (1 - T_{station\_tax})$$
其中，材料产出量 $Q_m$ 严格依据游戏公式计算：
$$Q_m = \lfloor BaseQuantity_m \times Yield_{total} \rfloor$$
- **综合精炼效率 ($Yield_{total}$)**：
  $$Yield_{total} = Efficiency_{facility} \times (1 + 0.01 \times S_{reprocessing}) \times (1 + 0.02 \times S_{efficiency}) \times (1 + 0.02 \times S_{scrapmetal}) \times (1 + Implant)$$
  - $Efficiency_{facility}$：空间站设施基础效率（NPC 空间站通常为 50%，玩家工程复合体可达 54%~60%）。
  - $S_{reprocessing}$：角色“再处理技术”技能等级 (1-5)。
  - $S_{efficiency}$：角色“高级再处理技术”技能等级 (1-5)。
  - $S_{scrapmetal}$：角色“废金属处理学”技能等级 (针对装备/舰船)。
  - $Implant$：精炼脑插加成 (如 RX-801 至 RX-804)。
- **矿物变现**：产出的三钛合金、类晶体胶矿、超新星核等基础矿物，按当前市场最佳买单深度换算为即时现金。
- **空间站精炼税**：扣除 NPC 空间站基于军团声望计算的精炼税率。

### 处置建议产出逻辑：
- 若 $R_{sell} > R_{reprocess} \times 1.05$：**建议直接出售**（理由：直接卖单收益更高，或物品具备功能溢价）。
- 若 $R_{reprocess} > R_{sell}$：**建议再处理**（理由：衍生装备市场无人问津或买单极低，解体出的基础矿物更具流动性且收益更高）。
- 若缺少飞行员技能或设施参数：前端允许手动输入假定等级，并在报告中醒目加注“【基于推断估算】”标签。

---

## 六、交付物与功能落地上线路线图

1. **第一阶段：数据底层就绪（当前已完成）**
   - SQLite SDE 数据库中 `sde_type_materials`（材料拆解比）与 `sde_types` 已全部就绪。
2. **第二阶段：分析核心算法库开发 (`src/eve/loot-analyzer.ts`)**
   - 封装精炼产出数学模型与买单深度遍历器。
   - 实现快照差分比较器。
3. **第三阶段：Web 前端交互面板集成 (`DataDock / LootPanel.tsx`)**
   - 在前端停靠栏提供“战利品一键整理”卡片。
   - 生成导出格式（如游戏内快捷复制文本、Markdown 清单）。
