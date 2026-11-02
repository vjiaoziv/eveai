# P8.5.5 密钥管理与轮换审计

## 修复前严重问题

P8.5.4 源码中存在：

~~~text
PIPELINE_KEY_STORE = { v1: '<redacted historical signing key>' }
~~~

该值硬编码并已进入 Git 历史。任何能读源码的人都可伪造凭证，属于必须修复的密钥管理缺陷。

## 修复后实现

src/trading/trading-pipeline.ts:16-35：

- PIPELINE_KEY_STORE 从环境变量 EVEAI_PIPELINE_SIGNING_KEYS 读取 JSON 对象。
- 没有环境变量时返回空字典，签名和验证安全失败。
- 源码不再包含生产签名密钥。
- tests/setup.ts:54 只注入测试密钥，测试环境不连接真实系统。
- .env.example 增加配置说明和占位值。

环境变量格式：

~~~text
EVEAI_PIPELINE_SIGNING_KEYS={"v1":"operations-secret","v2":"replacement-secret"}
~~~

## 轮换实测

tests/unit/p8-5-5-a01-a24.test.ts:291 A16：

1. 动态注册 v2_temp。
2. 用 v2_temp 签发并验证成功。
3. 删除 v2_temp。
4. 旧凭证验证返回【密钥失效】。

这证明字典式 keyId 轮换和旧密钥注销可使旧凭证失效。当前没有自动过期、密钥版本审计日志、HSM/KMS 或密钥加密存储；这些属于部署级改进。

## 泄露检查

- 当前源码不再包含旧硬编码密钥。
- 旧密钥仍存在于 Git 历史 c7e3fa7 及更早提交。必须视为已泄露并永久弃用，不能通过删除当前文件恢复信任。
- 日志中未发现签名密钥输出。
- 模型提示词不包含签名密钥。

## 结论

当前工作树的密钥管理已从硬编码改为环境注入，轮换机制有实测。但 Git 历史中的旧密钥仍是事实风险，生产部署必须使用全新密钥，并考虑 secret store、轮换记录和审计日志。
