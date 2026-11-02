# EVEAI 市场投资与交易决策用户使用指南
**文档编号**：`TRADING_USER_GUIDE.md`  
**基准日期**：2026-11-02  
**适用对象**：EVE Online 飞行员、个人投资者（Alpha / Omega 克隆）

---

## 一、双通道使用指南

本系统提供**Web 浏览器面板**与**全局命令行 (CLI)** 两种使用方式。

### 通道 1：浏览器管理面板
直接在浏览器中访问：👉 **`http://localhost:3000`**
1. **飞行员连接**：点击“通过 EVE Online 登录”，完成 EVE SSO 角色绑定；
2. **市场查看**：进入“市场”标签，查看各星域实时订单簿与深度，并可通过“自选列表”监控关注商品；
3. **AI 咨询**：在对话框中直接输入自然语言，例如：“分析我吉他机库里哪些物品适合变现”、“吉他到杜迪克西运什么最好”。

---

### 通道 2：跨平台全局命令行工具 (`eve-agent`)
已写入您的 Windows 用户 PATH（`C:\Users\JIAOZI\bin\eve-agent.cmd`），可在任何命令行终端、Codex、Hermes 或 dsh 中直接运行：

#### 1. 查账与风控限额
```bash
eve-agent capital
```
- 输出钱包现金、买单冻结金、强制 20% 储备金与单品投资上限。

#### 2. 一键执行高安跨区航运套利扫描
```bash
eve-agent scan-haul 0   # 扫描吉他 ➔ 杜迪克西 (15跳高安)
eve-agent scan-haul 1   # 扫描吉他 ➔ 赫克 (19跳高安)
eve-agent scan-haul 2   # 扫描吉他 ➔ 勒斯 (25跳高安)
```
- 输出即时变现（吃买单）与高毛利挂单两类机会，自动施加 5,000 万防强杀货值上限与 5,000 m³ 货舱过滤。

#### 3. 站内套利扫描
```bash
eve-agent scan-station 60003760   # 扫描吉他 4-4
eve-agent scan-station 60011866   # 扫描杜迪克西 IX-20
```

#### 4. 自动生成并审批交易订单草案 (TR-XXXXXX)
```bash
# 1. 自动根据当前钱包可支配余额生成一份最优交易草案
eve-agent draft-auto

# 2. 查看当前生成的草案清单
eve-agent drafts

# 3. 飞行员人工审批认可草案
eve-agent draft-approve TR-2026-000001
```

#### 5. 极速物品属性与解体比价
```bash
eve-agent item "狂怒者级"
eve-agent reprocess "狂怒者级"
eve-agent sde "SELECT type_id, name, zh_name FROM sde_types WHERE group_id = 26 LIMIT 5"
```

---

## 二、人工在游戏客户端中执行下单规范

当草案状态置为 `APPROVED` 后，请在 EVE Online 游戏客户端内执行：
1. **采购端**：按照草案中的 `买入单价` 与 `建议数量`，在对应空间站购买或设立买单；
2. **运输端**（如涉及航运）：将货物装载至工业舰，通过高安路线航行至目标空间站；
3. **销售端**：
   - 若策略为“即时秒变现”，直接右键“出售”吃下当地最高买单；
   - 若策略为“挂卖单”，右键“设立出售订单”，输入草案建议的卖价。
4. **回传实际数据**：执行完毕后可在系统内记录实际成交价，帮助系统校准市场滑点模型。
