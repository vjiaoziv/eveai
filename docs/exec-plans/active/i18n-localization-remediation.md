# EVEAI 汉化与 i18n 全链路统一修复计划 (I18N_LOCALIZATION_REMEDIATION.md)

模块代号：**i18n Unification（多语言统一）**
定位：把当前"前端半 i18n / 服务端中俄混杂 / 机器人纯俄语"三套割裂的语言体系，收敛为**单一 locale 事实源**，使 zh / en / ru 在 Web UI、服务端错误、SSO 同意页、周边预警、Agent 回答上一致生效。

状态：**计划已定稿；执行进度见文末附记（截至 2026-11-05：Phase 0–4 与 2.3 已完成并通过门禁，V8/V9/V10 冒烟与 Phase 5–6 待办）**
编写日期：2026-11-04
依据：2026-11-04 全量 i18n 只读审计（未改动任何文件）
权威仓库：`/home/ubuntu/projects/eveai`，分支 `deploy/eve-ai-agent`，审计时 HEAD `9e8e8b3`

---

## 一、现状基线（审计实测数据）

### 1.1 量化基线表

| 维度 | 实测值 | 评价 |
|---|---|---|
| i18n 键集 | 478 键 × 3 语（RU 源 / EN / ZH），缺键、多键、重复、空值均为 0 | ✅ 由 `Record<keyof typeof RU, string>` + typecheck 强制 |
| 键使用率 | 457 / 478 = **95.6%**（21 个死键） | ⚠ |
| 占位符三语一致 | **5 处不一致** | ❌ |
| 主视图接入 | **7 / 10** 已接 `t()` | ❌ 3 个完全未接 |
| 完全未接组件 | 4 个、合计 **2302 行 = web/src 17.7%**、占全部硬编码中文的 **99%** | ❌ |
| `t()` 调用点 | 581 | — |
| 硬编码中文代码行 | 516（已剥离注释） | ❌ |
| 无条件硬编码俄文 | 24（App 16 + api 6 + AssetsPanel 2） | ❌ 任何语言都显示俄文 |
| 条件分支俄文（正常） | 3（dates.ts `вчера`、SystemInspector `мин назад`×2） | ✅ 属 ru 分支 |
| 服务端 `src/web` 错误 | **4 个错误码 vs 141 条 prose 句子**（16 个路由文件） | ❌ |
| 服务端 `src/web` 语言 | 中文 65 条 + 俄文 173 条，混杂透传 | ❌ |
| 全 `src/` 字符串字面量 | 中文 475 + 俄文 821 | ❌ |
| 机器人 / CLI | Discord 55、Telegram 51、chat 40、CLI 6、scheduled 31 条俄文，**中文 0** | ❌ 无 i18n 层 |
| 服务端 locale 支持 | `readLocale()` / `ConsentLocale` / `Advisory.text` **只有 ru｜en，无 zh** | ❌ |
| 文档 | 321 md 中 256 中文主导（80%）、58 英文主导 | ⚠ 可接受 |
| i18n 门禁测试 | **0**（仅 2 处脆弱正则断言） | ❌ |

### 1.2 八个确定性缺陷（按严重度）

| # | 缺陷 | 证据位置 |
|---|---|---|
| D1 | **中文用户市场详情必现 400**：`?lang=zh` 被服务端拒绝并回俄文报错 | `TypeInfoPanel.tsx:31` → `api.ts:281` → `market-routes.ts:156-158`；根因 `market-type-info.ts:11` `MarketInfoLang = 'en' \| 'ru'` |
| D2 | 中文浏览器收到**俄语**周边预警 | `map-routes.ts:1073` `readLocale()`：非 `en` 开头一律 `'ru'` |
| D3 | 预警数据结构**无中文字段** | `eve-map/advisor.ts:35` `text: { ru: string; en: string }` |
| D4 | 中文用户进入**俄语** SSO 同意页；语言切换只有 RU/EN | `chat-routes.ts:176` `language === 'en' ? 'en' : 'ru'`（前端已正确传 `'zh'`，被丢弃）；`localized-eve-consent-page.ts:8` `ConsentLocale = 'ru' \| 'en'` |
| D5 | 3 个主视图完全绕过 i18n | `P9TradingScreen.tsx`(681行/175中文)、`P93AccountingPanel.tsx`(566/155)、`AssetScreen.tsx`(820/154)、`TradingScreen.tsx`(235/27) |
| D6 | 24 处**无条件俄文**任何语言都显示 | `App.tsx` 16、`api.ts` 6、`profile/AssetsPanel.tsx` `м³`×2 |
| D7 | 导航 10 项中 3 项硬编码中文；4 个屏无语言切换入口 | `Sidebar.tsx:44-46` |
| D8 | 标题/单位/时间格式不跟随 locale | `web/index.html` 中文 `<title>`；`i18n.tsx:939` 只设 `lang` 不设 `title`；`SystemInspector` zh 走英文 `5m ago`；`PerimeterChat.tsx:297` zh 走 `en-GB` |

### 1.3 两项关键可行性结论（已实测验证）

1. **SDE 中文数据已就绪，无需新导入**
   `data/eve-agent.db`（只读实查 `type_id=34`）：
   - `sde_types.data_json.name` = `{"de":"Tritanium","en":"Tritanium",...,"ru":"Tritanium","zh":"三钛合金"}`
   - `sde_groups.data_json.name.zh` = `"矿物"`
   而 `market-type-info.ts:300` 的 `localize(value, lang)` 实现为 `localized[lang] ?? localized.en`，**本身与语言无关**，只需放开类型与入参校验。

2. **错误码机制已存在端到端，只是没人用**
   - `api.ts:105` 用 `/^[a-z][a-z0-9_]*$/` 探测 snake_case 码，命中即视为机器码
   - `ApiRequestError.code`（`api.ts:53-61`）已承载
   - `SettingsScreen.tsx:66-67` 已实现 `code → TranslationKey` 映射（4 码）
   - `MarketAiSearch.tsx:51` 已实现 `status → t()` 映射（429/5xx）
   - 但 `src/web` 全部路由**只有 `settings-routes.ts` 返回 4 个码，其余 141 条是 prose**

---

## 二、目标与验收标准（全部可机检）

**总目标**：切换 zh / en / ru 任一语言后，用户在任意入口（Web 各视图、错误提示、SSO 同意页、周边预警、AI 回答）看到的自然语言 100% 属于该语言。

| ID | 验收标准 | 检测方式 |
|---|---|---|
| V1 | `npm run typecheck` / `lint` / `build` / `npx vitest run` 全绿 | 命令 |
| V2 | i18n 三语键集 100% 对齐、占位符 100% 一致、无空值 | 新增 `i18n-integrity.test.ts` |
| V3 | `web/src` 硬编码中文行 = 0（`i18n-dictionary.ts` 除外） | 新增 `i18n-no-hardcoded-strings.test.ts` |
| V4 | `web/src` 无条件西里尔字面量 = 0（仅允许结构化的 ru 分支） | 同上测试 |
| V5 | 10 / 10 主视图接入 `t()` | 同上测试 + 逐屏人工三语切换冒烟 |
| V6 | `src/web` 错误返回 100% 为 snake_case code；前端 100% 有码→键映射，未知码回退通用文案 | 新增 `api-error-codes.test.ts` |
| V7 | 中文 locale 请求 `/market/types/:id/info?lang=zh` 返回 200 且中文名 | 单测 + 手工 |
| V8 | 中文 `Accept-Language` 下周边预警为中文、SSO 同意页为中文 | 单测 + 手工 |
| V9 | 切换 en 后 AI 回答为英文（`OPENAI_RESPONSE_LANGUAGE` 被请求级覆盖） | 手工冒烟 |
| V10 | 语言切换按钮在 10/10 视图可见 | 人工 |

---

## 三、架构决策

### 决策 A：错误传递采用「错误码」，而非服务端按用户语言翻译
**依据**：`ApiRequestError.code` + regex 探测 + Settings/MarketAiSearch 两处已验证的映射模式已存在；服务端 141 条 prose 中 65 中文 / 173 俄文（含非 error 字段）本质是"服务端不知道用户语言"的症状。
**做法**：服务端只回 `{ error: '<snake_case_code>' }`；前端集中维护 `code → TranslationKey` 表并用当前 locale 渲染。
**好处**：消除中英俄混排、单一事实源、服务端无需感知 locale、payload 更小。
**兼容**：`api.ts:105` 的 regex 同时接受 code 与 prose，可**按路由文件分批平滑迁移**，不需一次性切换。

### 决策 B：locale 单一来源 = 前端 `eveai.locale.v1`，向下游显式传递
- 前端已在 `localStorage['eveai.locale.v1']` 持久化（`i18n.tsx:929`）
- 服务端**不再猜测**，改为读取显式信号（请求头 `X-locale`，或沿用已有 `language` 字段）
- 服务端 `readLocale()` 支持 `zh | en | ru`；**未知值回退 `ru`**（见第九节决策项 Q1：保护存量俄语用户，避免改变现有默认行为）

### 决策 C：服务端返回「语言中立的数据 + key」，渲染归前端
- `Advisory.text` 由 `{ru, en}` 扩为 `{zh, ru, en}`
- 数据字段（如 `type_name_zh`、`data_json.name.zh`）在服务端按请求 lang 解析后返回纯文本

### 决策 D：Agent 回答语言绑定请求 locale
- 管道已存在：`AgentTurnContext.locale`（`turn-context.ts:18`）+ `buildAgentTurnContext` 已接收 `locale` 输入
- 但 `executor.ts:931` 硬编码 `config.openai.responseLanguage`，**只需改为可被请求覆盖**
- 语义映射：`zh→Chinese`、`en→English`、`ru→Russian`（`prompts.ts:228` `normalizeResponseLanguage` 已支持）
- `config.openai.responseLanguage` 降级为**未提供 locale 时的默认值**

### 决策 E：不引入第三方 i18n 库（最小依赖）
现有 `i18n.tsx` 已满足需求（键值表 + `t(key, params)` + 占位符替换 + localStorage）。仅做**结构解耦**，不换库、不加依赖。

---

## 四、分阶段任务

> 执行纪律：每个 Phase 独立 commit；每完成一个子任务跑一次 `typecheck + lint + 相关 vitest`；不触碰仓库中已暂存的用户改动（`docs/audit/**` 重命名、`docs/exec-plans/active/index.md`、`loot-manager-roadmap.md`）。

### Phase 0 — 先立门禁（0.5 天）

| ID | 任务 | 产出 |
|---|---|---|
| 0.1 | 新增 `tests/unit/i18n-integrity.test.ts`：解析 `i18n.tsx` 三个对象字面量，断言键集相等、占位符集合一致、无空值 | V2 门禁；**当前会先红（5 处占位符不一致）**，作为待修清单 |
| 0.2 | 新增 `tests/unit/i18n-no-hardcoded-strings.test.ts`：扫描 `web/src`，除字典文件外禁止 CJK 行与无条件西里尔字面量；对 `dates.ts` / `SystemInspector` 的条件分支做**结构化白名单**（必须位于 `if (locale === 'ru')` 或三元分支内） | V3/V4 门禁；**当前会红（516 中文行 + 24 俄文）** |
| 0.3 | 记录基线数字到测试快照注释，后续每阶段对比 | 可追溯 |

**说明**：门禁先红是刻意的——它把"改了多少"变成可量化的收敛曲线，而不是主观判断。

### Phase 1 — P0 功能性故障：中文用户直接坏（1 天）

| ID | 任务 | 改动位置 | 验收 |
|---|---|---|---|
| 1.1 | `MarketInfoLang` 放开为 `'en' \| 'ru' \| 'zh'`；`getMarketTypeInfo` 中 `type.name` / `group.name` / `category.name` 从"直接读列"改为 `localize(data_json.name, lang)`（列值是英文，中文在 `data_json.name.zh`）；`market-routes.ts:156` 接受 `zh` | `src/eve/market-type-info.ts:11,77,300`、`src/web/market-routes.ts:156` | **V7** |
| 1.2 | `readLocale()` 支持 `zh`：读显式 `X-locale`/`language`，回退解析 `Accept-Language`，三语均识别 | `src/web/map-routes.ts:1073` | V8 |
| 1.3 | `Advisory.text` 增加 `zh` 字段，并为全部构造点补中文文案 | `src/eve-map/advisor.ts:35` + 全部 `text: { ru, en }` 构造点（需先盘点处数） | V8 |
| 1.4 | `ConsentLocale` 扩为 `'zh' \| 'ru' \| 'en'`；同意页 copy 增加 ZH；`auth-routes.ts:68,95` 与 `chat-routes.ts:176` 接受 `zh`（消除 zh→ru 降级） | `localized-eve-consent-page.ts`、`eve-consent.ts`、`auth-routes.ts`、`chat-routes.ts` | V8 |
| 1.5 | `PerimeterChat` 时间格式 zh 用 `zh-CN`；`SystemInspector.formatAge` 补 zh 分支（`X 分钟前` / `X 小时前`） | `PerimeterChat.tsx:297`、`SystemInspector.tsx:118` | V5 |

**Phase 1 完成即消除 D1–D4，中文用户不再遇到俄语功能界面。**

### Phase 2 — 前端硬编码清零（2–3 天）

#### 2.0 结构前置：字典与 React 解耦
- 新建 `web/src/i18n-dictionary.ts`（纯 TS，无 React import）承载 `RU` / `EN` / `ZH` 三张表 + `translateOutOfReact(key, locale)` + `LOCALE_OPTIONS`
- `i18n.tsx` 改为从字典导入并只保留 Provider / hook / `LocaleSwitch`
- **动机**：`api.ts` 在 React 外无法用 `useI18n()`，必须有非 React 入口才能翻译 24 处网络/应用级错误
- 影响面：仅 2 个文件，无行为变更，单测保持通过

#### 2.1 四个未接入组件（按组件独立提交）

| 顺序 | 组件 | 规模 | 任务 |
|---|---|---|---|
| a | `TradingScreen.tsx` | 235 行 / 27 中文行 | 提取文案 → 三语键 → 全量替换 `t()` |
| b | `AssetScreen.tsx` | 820 行 / 154 中文行 | 同上（含 `TAG_LABELS`、`CATEGORY_LABELS`、`CHANGE_LABELS` 等静态映射表需整体迁移为键前缀式，如 `assetTag_selfUse`） |
| c | `P93AccountingPanel.tsx` | 566 行 / 155 中文行 | 同上 |
| d | `P9TradingScreen.tsx` | 681 行 / 175 中文行 | 同上；注意其内部嵌套 `P93AccountingPanel` |

**新增键预估**：约 350–450 个（按实测 511 中文行、平均每行 0.9 个可见串估算；实际以提取结果为准）。
**每组件完成标志**：该组件 CJK 行 = 0 且 `t()` 覆盖其全部 JSX 文本 / aria / placeholder。

#### 2.2 全局俄文与杂项

| ID | 任务 | 位置 |
|---|---|---|
| 2.2.1 | `App.tsx` 16 条俄文错误 → `t()` | `App.tsx:57,58,149,286,289,302,315,329,346,376,394,446,458,488,495,649` |
| 2.2.2 | `api.ts` 6 条俄文 → 经 2.0 的 `translateOutOfReact` 本地化 | `api.ts:71,74,77,79,98,114` |
| 2.2.3 | `Sidebar` 3 项导航接入 `t()`（新增 `navRealLedger` / `navAssets` / `navPaperTrading`） | `Sidebar.tsx:44-46` |
| 2.2.4 | `м³` → `m³` 或 `t('unitCubicMeter')`（三语均 `m³` 即可） | `AssetsPanel.tsx:113,183` |
| 2.2.5 | `document.title` 跟随 locale（Provider effect 中赋值） | `i18n.tsx:937-940` |
| 2.2.6 | `LocaleSwitch` 补到 4 个未接入屏 + `DataDock` | 5 处 JSX |
| 2.2.7 | 修正 5 处占位符三语不一致 | `i18n.tsx:74,79,649-651,666-667` |
| 2.2.8 | `p93-freshness.ts` 硬编码中文与 `toLocaleString('zh-CN')` 改为接收 locale | `p93-freshness.ts:15,25,37` |
| 2.2.9 | `LocaleSwitch` 未覆盖屏补齐后复核 V10 | — |

#### 2.3 死键清理
21 个未引用键：建议**保留 `settings*` 系列**（与后端错误码绑定），**删除 `marketAttrGroup_*` 9 个与确认无调用方的 12 个**。以 0.1 的键使用率测试固定结果。

### Phase 3 — 服务端错误码化（1–2 天）

| ID | 任务 | 说明 |
|---|---|---|
| 3.0 | **前置盘点**：grep `tests/`、`web/src` 对 141 条 prose 的字符串依赖 | 决定哪些可直接替换、哪些需保留兼容 |
| 3.1 | 新建 `src/web/error-codes.ts`：定义规范化 code 清单（预计 40–60 个，从 141 条 prose 归并） | 单一事实源 |
| 3.2 | 按文件分批替换（**保持 regex 兼容，可逐文件合并回滚**）：`market-routes`(26) → `chat-routes`(22) → `map-routes`(19) → `trading-routes`(19) → `asset-routes`(13) → `profile-routes`(8) → `auth-routes`(7) → 其余(27) | 每批一 commit |
| 3.3 | 新建 `web/src/api-error-keys.ts`：`Record<ErrorCode, TranslationKey>` | 与 `SettingsScreen.SETTINGS_ERROR_LABELS` 合并统一 |
| 3.4 | 未知 code 回退 `t('requestFailed')`；保留 prose 分支直到全部迁移完成 | `api.ts:105-108` |
| 3.5 | `SettingsScreen` 改用集中表 | `SettingsScreen.tsx:40-45,66-67` |

**注意**：`src/web` 中除 error 字段外还有 prose 出现在 `message` / `notice` 等字段（`transparency.ts`、`profile-data.ts`、`eve-consent.ts`），**3.x 只覆盖 error 字段**，其余归入 Phase 5 或数据字段本地化。

### Phase 4 — Agent 回答语言绑定（0.5–1 天）

| ID | 任务 | 位置 |
|---|---|---|
| 4.1 | 前端发起请求时带 locale（复用 Phase 1 的 `X-locale` 或既有字段） | `web/src/api.ts`、`agent-request-client.ts` |
| 4.2 | 服务端在创建 agent 请求时读取 locale 并透传到 `buildAgentTurnContext` | `src/web/agent-requests.ts`、`turn-context.ts` |
| 4.3 | `executor.ts:931` 由硬编码 `config.openai.responseLanguage` 改为 `requestLocale ?? config.openai.responseLanguage`；经 `normalizeResponseLanguage` 归一 | `src/agent/executor.ts:931` |
| 4.4 | 统一 `.env.example:109`（`Russian`）与 `config.ts:243` 默认值（`Chinese`）为 `Chinese` | 2 处 |
| 4.5 | 验收：切 en → AI 回答英文；不带 locale → 维持配置默认 | **V9** |

**兼容性红线**：`config.openai.responseLanguage` 必须保留为回退，Telegram/Discord/CLI 等无 locale 入口行为**不变**。

### Phase 5 — 机器人 / CLI i18n（二期，1–2 天，可选）

| ID | 任务 |
|---|---|
| 5.1 | 新建 `src/i18n/core.ts`（纯函数 + 三语字典，**不依赖 React**），与 `web/src/i18n-dictionary.ts` 共享词条（需先确定共享策略：复制或抽公共包） |
| 5.2 | `discord/bot.ts`(55)、`telegram/`(51)、`chat/shared.ts`(40)、`cli/`(6)、`scheduled/`(31) 逐文件迁入 |
| 5.3 | 默认语言**保持俄语**（保护存量部署），新增 `/lang zh|en|ru` 命令或按用户 profile 切换 |

> ⚠ 现有部署可能完全依赖俄语默认，**Phase 5 不得擅自改默认值**。

### Phase 6 — 落地页与文档（三期，0.5 天，可选）

| ID | 任务 |
|---|---|
| 6.1 | 根 `index.html`（435 行纯英文营销页）：加三语切换，或在文档中明确"该页为英文 landing，不在 i18n 范围" |
| 6.2 | `web/index.html` 的 `<title>` 由 2.2.5 覆盖 |
| 6.3 | README 双语（可选，非阻塞） |

---

## 五、执行顺序与依赖关系

```
Phase 0（门禁，先红）
   │
   ├─→ Phase 1（P0 故障，无依赖，可立即做）──────┐
   │                                              │
   ├─→ Phase 2.0（字典解耦）──→ Phase 2.1~2.3     │
   │                                              ├─→ 终验 V1~V10
   ├─→ Phase 3（错误码，依赖 2.0 的 translate 出口）│
   │                                              │
   └─→ Phase 4（Agent 语言，依赖 Phase 1 的 locale 传递）
   
Phase 5、6 为独立二期/三期，不阻塞终验
```

**关键路径**：Phase 0 → Phase 2.0 → Phase 2.1（4 组件）→ Phase 3 → 终验
**可并行**：Phase 1 与 Phase 2.0 互不依赖，可由两人并行。

---

## 六、风险与回滚

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | 改 `readLocale()` 默认值会让存量俄语用户看到中文/英文 | 高 | **未知值回退保持 `ru`**，只显式新增 `zh` 识别；不改变现有人行为 |
| R2 | 141 条 prose 一次性替换导致前端拿到裸 code、界面显示 `unknown_model` 类原始码 | 高 | 分 8 批按文件迁移；`api.ts:105` regex 兼容 prose，code 先落 `code` 字段再改前端映射；未知码回退 `requestFailed` |
| R3 | 4 组件 2302 行提取文案易漏 / 易串 | 中 | 每组件独立 commit；0.2 硬编码扫描逐组件归零；人工三语冒烟 |
| R4 | 字典从 `i18n.tsx` 拆出可能引入循环依赖或破坏 24 个现有测试 | 中 | 2.0 独立 commit，先跑全量 vitest 再继续 |
| R5 | `Advisory.text` 加 zh 需改动所有构造点，漏一处即 `undefined` 渲染 | 中 | TypeScript 类型即门禁（加必填 `zh` 后 typecheck 会红到每一处） |
| R6 | `getMarketTypeInfo` 改读 `data_json` 影响现有 en/ru 显示 | 中 | 单测覆盖 en/ru/zh 三语输出；先做只增不改的 zh 分支 |
| R7 | Agent 语言绑定后 Telegram/Discord 回答语言意外改变 | 高 | 4.3 必须是 `requestLocale ?? config`，无 locale 入口行为完全不变 |
| R8 | 仓库存在用户已暂存改动 | 中 | **不修改 `docs/exec-plans/active/index.md`、`loot-manager-roadmap.md`、`docs/audit/**`**；本计划为新增文件 |

**回滚策略**：每 Phase 独立 commit → 出问题 `git revert` 单个 Phase；Phase 3 的 8 批各自可回滚。

---

## 七、验证矩阵

| 阶段 | 命令门禁 | 人工冒烟 |
|---|---|---|
| 每个子任务后 | `npm run typecheck` | — |
| 每个 commit 前 | `npm run lint` + `npx vitest run` | — |
| Phase 0 后 | 新增 2 个 i18n 测试（**预期红**，记录基线） | — |
| Phase 1 后 | + V7/V8 单测 | 中文浏览器：市场详情 200 中文名、周边预警中文、SSO 同意页中文 |
| Phase 2 后 | + V2/V3/V4/V5（**预期全绿**） | 10 视图 × 3 语言逐屏切换，无中文/俄文泄漏；标题跟随 |
| Phase 3 后 | + V6 | 触发 400/401/403/429/500 各一次，确认三语文案正确、无裸 code |
| Phase 4 后 | + V9 | 切 en 提问 → 英文回答；切 ru → 俄文回答 |
| 终验 | 全量 `typecheck` + `lint` + `build` + `vitest` + V1~V10 全绿 | 三语言全流程回归 |

---

## 八、工作量估算

| Phase | 内容 | 估算 | 优先级 |
|---|---|---|---|
| 0 | 门禁测试 | 0.5 天 | 必做 |
| 1 | P0 功能故障（D1–D4） | 1 天 | **最高** |
| 2 | 前端硬编码清零（2302 行 + 24 俄文 + 杂项） | 2–3 天 | **最高** |
| 3 | 服务端错误码化（141 条 → 40–60 码） | 1–2 天 | 高 |
| 4 | Agent 语言绑定 | 0.5–1 天 | 中 |
| **合计（必做 0–4）** | | **5–7.5 天** | |
| 5 | 机器人 / CLI i18n | 1–2 天 | 二期 |
| 6 | 落地页 / 文档 | 0.5 天 | 三期 |

---

## 九、待确认项（每项已给推荐默认值，未确认前不执行）

| # | 问题 | 推荐默认 | 理由 |
|---|---|---|---|
| Q1 | 服务端 locale 无法识别时回退 `ru` 还是 `zh`？ | **回退 `ru`** | 保护存量俄语用户；前端默认 zh 已由显式信号覆盖，回退值几乎不会触发 |
| Q2 | 141 条 prose 一次性还是分批迁移？ | **按 8 个路由文件分批** | 每批可独立回滚，regex 兼容保证中途态可用 |
| Q3 | 机器人 / CLI 是否纳入本次？ | **纳入 Phase 5（二期）** | 与 Web 主链路无依赖，避免阻塞 P0 |
| Q4 | 是否修改 `.env.example` 的 `OPENAI_RESPONSE_LANGUAGE=Russian`？ | **改为 `Chinese`** | 与 `config.ts:243` 默认值统一；仅示例文件，不影响现网 `.env` |
| Q5 | 21 个死键删除还是保留？ | **删 21 个中的 12 个**，保留 `settings*`(10) 与 `dockEsiLinked` 等潜在接口键 | 需逐个确认调用方后定 |
| Q6 | 根 `index.html` 英文营销页是否要三语？ | **本期仅加文档说明，不改** | 非用户主链路，避免范围蔓延 |
| Q7 | 是否引入第三方 i18n 库（i18next 等）？ | **不引入** | 现有实现够用，遵守最小依赖原则 |

---

## 十、本计划的边界

- **不改动**：EVE 游戏资产写入逻辑、任何 ESI 权限、密钥与生产配置
- **不擅自改默认语言**：存量俄语部署行为在 Phase 5 完成前保持不变
- **不动用户已暂存改动**：`docs/audit/**` 重命名、`docs/exec-plans/active/index.md`、`loot-manager-roadmap.md`
- **本文件为新增文件**，评审通过并登记到 `docs/exec-plans/active/index.md` 后再开始执行（登记动作待暂存区稳定后进行）

---

*本计划基于 2026-11-04 对权威仓库的只读审计编写，所有缺陷编号（D1–D8）、量化数字与文件行号均可复现；执行时若实测与本计划不符，以代码实况为准并回写本文件。*
---

## 附记：执行进度回写（2026-11-05，第二轮更新）

- **Phase 0–4 全部完成**（含本轮补完的 Phase 3 残余）：
  - Phase 3 残余：首轮实施遗漏的 30+ 条 prose error（19 处中文三元/回退、12 条俄文模板、publicError / admission / live-session / avoid / Fastify 4xx 等动态产出）已全部码化；`src/web` error 字段 prose = **0**（V6 机检）。
  - 新增 `tests/unit/api-error-codes.test.ts`（V6 门禁：禁 prose 字面量与模板、禁原始 message 透传、可产出码 100% 已映射、publicError 无西里尔）。
  - 码表 93 → **156** 码；字典新增 62 键后经 2.3 清理 9 个死键 → **1242 键**。
  - 前端新增 `translateApiErrorValue()`，集中翻译成功载荷内的 error 字段（App / PerimeterChat 两处消费点接入）。
- **Phase 2.3 完成**：死键审计 17 个候选 → 删除 9 个全仓零引用键（checkedSources、toolCalls、composerHint、profileCloneImplants、dockOpenMarket、dockHistoryEmpty、dockAlertsEmpty、dockEsiLinked、answerOpenInDock）；`marketAttrGroup_*` 8 键经核实为 `t(\`marketAttrGroup_${group.key}\`)` 动态使用，**保留**（以证据修正 Q5 原判断）。
- **本轮复核**：tsc（src）、tsc（web）、eslint `--max-warnings 0` 退出码均为 0；vitest 272 文件中 269 通过，剩余 3 文件 / 5 用例失败全部位于 `tests/audit/p9-3.3.7/*`，根因为**用户并行编辑的 src/trading 资产镜像/账本 WIP**（与本计划无关，不代改）。
- **未执行任何 commit**：暂存区 99 项用户改动未触碰，我方改动全部保持未暂存。
- **第三轮（同日）：V7/V8/V9 机检补齐**
  - 新增 `tests/unit/i18n-http-zh.test.ts`：经真实路由 `app.inject` 验证 `?lang=zh` 市场详情返回中文（V7 运行时）、同意页 `language=zh/en/未知` 分别渲染 zh/en/ru（V8 运行时，未知值回退 ru 保持 R1/Q1）。
  - 抽取 `src/web/read-locale.ts`（原 map-routes 内部函数），新增 `tests/unit/web-read-locale.test.ts` 覆盖首标签优先与回退语义；`eve-consent.test.ts` 增加 zh 整页断言；`map-tools-thread.test.ts` 增加 `appendAdvisory(..., 'zh')` 中文落库断言。
  - V9 机检双路：coordinator 将请求 locale 传入 runner（无 locale 时为 undefined 走配置回退）+ `buildDeveloperPrompt`/`normalizeResponseLanguage` 语言块断言（zh/en/ru/空值回退 Chinese）。
  - 复核：`npm run check` **EXIT=0（274 文件 / 2351 用例）**。
- **第四轮（同日）：V10 机检 + 浏览器运行时冒烟**
  - 新增 `tests/unit/i18n-locale-switch-coverage.test.ts`：App 十个 activeView 主视图 + DataDock 共 11 个组件必须 import 并渲染 `<LocaleSwitch`（各恰好 2 处），11/11 通过。
  - 真实浏览器冒烟（内置浏览器 → 127.0.0.1:3000，运行中的服务从磁盘伺服今日新构建的 `web/dist`）：登录页默认中文 → 切 EN（整页文案 + `document.title` 变 "EVE AI — Tactical Officer"）→ 切 RU（"EVE AI Тактический офицер"）→ 切回中文；访客模式进入应用后，聊天视图、市场视图（zh 市场 / en Market / ru Маркет）、DataDock 均可见可用语言切换，文案实时跟随，控制台零错误。
  - 冒烟发现（均属计划内已声明的后续范围，非回归）：中文界面下市场**分类树/区域名仍为英文数据**（数据字段本地化按计划归 Phase 5/决策 C 后续）；部分 zh 词条本身为英文（如 "Paper Trading"，属字典值取舍，非硬编码）。
  - 说明：登录页/应用内会话经"以访客身份继续"创建（应用正常访客流程，写入 1 组 users/telegram_sessions 行）；运行中的服务为 Nov04 启动的旧后端，未重启、未触碰。
- **待办**：V9 真实 AI 回答语言冒烟（需以新构建重启服务后在 en/ru 下提问；机检已覆盖 enqueue→runner→prompt 全链路）、Phase 5（机器人/CLI，二期）、Phase 6（落地页/文档，三期）、登记 `docs/exec-plans/active/index.md`（待暂存区稳定）。
