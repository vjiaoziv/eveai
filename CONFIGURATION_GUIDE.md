# EVE AI Agent 环境变量与高级配置指南 (CONFIGURATION_GUIDE.md)

本指南系统解析 `.env` 配置文件中的每一个核心选项、取值范围与推荐实践。

---

## 一、网络服务配置 (Server & Ingress)

```ini
HOST=127.0.0.1
PORT=3000
WEB_BASE_URL=http://localhost:3000
WEB_CHAT_ENABLED=true
```
- **`HOST`**：必须固定为 `127.0.0.1`，仅允许本机回环访问，保障安全性。
- **`PORT`**：服务监听端口，默认为 `3000`。
- **`WEB_BASE_URL`**：浏览器访问的标准 URL，与 SSO 回调匹配。
- **`WEB_CHAT_ENABLED`**：**必须显式设置为 `true`**。若为 `false`，Web 界面将关闭 AI 对话功能仅作为监控看板。

---

## 二、模型服务配置 (OpenAI Responses API)

```ini
OPENAI_PROVIDER=openai
OPENAI_API_KEY=<YOUR_OPENAI_API_KEY>
OPENAI_MODEL=gpt-4o
OPENAI_RESPONSE_STATE_MODE=stateless
OPENAI_STORE_RESPONSES=false
OPENAI_RESPONSE_LANGUAGE="Simplified Chinese"
```
- **`OPENAI_PROVIDER`**：
  - `openai`：官方 OpenAI Responses API（首选）。
  - `modelhub`：第三方兼容代理。
- **`OPENAI_API_KEY`**：您的官方 API 密钥。
- **`OPENAI_MODEL`**：
  - `gpt-4o`：高通用性、高性价比、极佳的中文理解力。
  - `gpt-5.6-sol` / `gpt-6-astra`：具备更深层推理能力的大模型选项。
- **`OPENAI_RESPONSE_STATE_MODE`**：
  - `stateless`：无状态模式（推荐），每轮从 SQLite 重构纯净上下文，不产生历史污染。
- **`OPENAI_STORE_RESPONSES`**：
  - `false`：不留存外部云端日志，最大程度保护隐私。
- **`OPENAI_RESPONSE_LANGUAGE`**：
  - 设为 `"Simplified Chinese"`（或 `Chinese`），强制 AI 默认采用规范的 EVE 官方简体中文术语回复。

---

## 三、EVE Online SSO 与 ESI 数据接口配置

```ini
EVE_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
EVE_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
EVE_CALLBACK_URL=http://localhost:3000/auth/eve/callback
ESI_USER_AGENT=EVEAI/4.0 (+https://github.com/example/eveai; contact=operator@example.com)
```
- **`EVE_CLIENT_ID`**：在 EVE 开发者中心创建的应用客户端 ID。
- **`EVE_CLIENT_SECRET`**：在 EVE 开发者中心创建的应用客户端密钥。
- **`EVE_CALLBACK_URL`**：必须与 EVE 开发者中心填写的完全一致。
- **`ESI_USER_AGENT`**：向 CCP ESI 声明的客户端标识，按规范填入您的联系方式。

---

## 四、本地数据与市场默认值配置

```ini
DB_PATH=./data/eve-agent.db
SDE_DATA_DIR=./data/sde
DEFAULT_MARKET_REGION_ID=10000002
DEFAULT_MARKET_REGION_NAME="The Forge"
```
- **`DB_PATH`**：SQLite 数据库存放文件路径，单文件持久化。
- **`SDE_DATA_DIR`**：静态数据导入源目录。
- **`DEFAULT_MARKET_REGION_ID`**：默认主贸易星域（`10000002` 为伏尔戈星域 / The Forge，即吉他 Jita 所在地）。
- **`DEFAULT_MARKET_REGION_NAME`**：默认星域中文/英文名称。
