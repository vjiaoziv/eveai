# P8.5.5 HMAC、规范化序列化与恒定时间比较审计

## 修复前问题

P8.5.4 的 buildCanonicalCredentialPayload 使用数组 join('|')，并把多个金额机械转换为 toFixed(2)。主要风险：

- 字段中的竖线、换行和空字符串可能形成边界歧义。
- null、undefined、NaN、Infinity 没有统一拒绝策略。
- 所有数值使用相同精度规则，不符合数量、价格和 ISK 的不同语义。
- 缺失 opportunityId 时以空字符串参与签名，导致关键授权上下文可缺失。

## 修复后实现

src/trading/trading-pipeline.ts:71-96 现在构造版本化 JSON：

~~~text
schema: eveai-pipeline-credential-v3
~~~

规则：

- 字符串字段使用 requireText，拒绝空值和超长值。
- opportunityId 必填。
- characterId、typeId、站点 ID、数量要求安全整数。
- 价格、资本、净利润要求有限数值且最多两位小数。
- verifiedAt、expiresAt 必须是有效 ISO 时间，并规范化为 UTC ISO 字符串。
- marketSnapshotHash 必须是 16 到 64 位十六进制。
- JSON 对象使用固定字段顺序，字段边界不再依赖分隔符。

测试证据：tests/unit/p8-5-5-crypto-atomicity.test.ts:68

- nonce 为 a|b 与 a 换行 b 产生不同 canonical payload。
- 1 与 1.00 归一为相同金额；1.01 与 1.00 不同。
- NaN、Infinity、1.5 数量、空 opportunityId、1.001 金额均被拒绝。

## HMAC 与比较

- src/trading/trading-pipeline.ts:98-107 使用 Node.js crypto.createHmac('sha256', secret)。
- src/trading/trading-pipeline.ts:110-117 使用 crypto.timingSafeEqual。
- safeCompareHex 先验证十六进制格式、偶数长度和非空，再比较 Buffer。
- 长度不同或格式畸形时安全失败。
- 错误信息区分缺失、过期、篡改、参数不一致和密钥失效，但不输出签名原文或密钥。

结论：签名比较采用恒定时间比较以降低比较阶段时序侧信道风险；这不能证明整个验证流程没有其他侧信道，也不能替代密钥管理和部署安全。

## 精度

- 价格、资本、净利润：最多 2 位小数，1e-8 内视为同一分单位。
- 数量：必须为正安全整数。
- 时间：ISO 时间统一转换为 UTC ISO 字符串。
- 不再把数量、文本和所有数值机械转换为 toFixed(2)。

## 结论

规范化歧义和精度问题已修复，并有专门测试。仍需注意 JS number 不是任意精度 Decimal；当前业务精度限制在两位小数和安全整数范围，若未来支持更高精度 ISK，应改为整数最小单位或 Decimal/BigInt。
