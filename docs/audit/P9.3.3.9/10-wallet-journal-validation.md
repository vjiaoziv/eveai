# 10 钱包交易字段严格验证

## 1. 统一标准化入口

`src/trading/p9-3-evidence-service.ts:120-136` 提供：

```ts
normalizeEsiWalletTransaction(row)
```

它是同步服务和测试共用的字段边界，不进行宽松强制转换。

## 2. 字段规则

| 字段 | 规则 |
|---|---|
| `is_buy` | 必须严格为 boolean；不接受字符串 `"false"`/`"true"`。 |
| `transaction_id` | 必须为正安全整数。 |
| `type_id` | 必须为正整数。 |
| `quantity` | 必须为正整数。 |
| `unit_price` | 必须为有限非负数。 |
| `date` | 必须可解析为有效日期。 |
| `location_id` | 必须为有效正整数/安全整数。 |

未知方向不会默认转换为 BUY。任何关键字段不满足规则时抛出 `EsiWalletTransactionValidationError`，同步层将其记录为可重试/可隔离失败，而非静默跳过。

## 3. 独立测试

测试：`tests/audit/p9-3.3.9/wallet-adversarial.test.ts`。

覆盖：

- 字符串 `is_buy` 被拒绝。
- fractional/过大/非正整数边界被拒绝。
- 零或负数 quantity 被拒绝。
- `Infinity`/NaN 等非有限价格被拒绝。
- 无效日期被拒绝。
- 缺少 `location_id` 被拒绝。
- malformed row 阻止游标推进。
- 同批次高位合法记录不能掩盖低位 malformed 记录。

所有相关独立测试通过。

## 4. Journal 响应形状

`tests/audit/p9-3.3.9/character-sync-adversarial.test.ts:135` 还验证：

- 非数组 wallet journal 响应不会被转换为成功空同步。
- 非法的逐行 `balance` 会拒绝整批写入。

## 5. 结论

钱包交易标准化在审查范围内满足“不猜测、不强制转换、不把 UNKNOWN 变 0”的要求。未发现方向字段或数值字段被错误接受。

## 6. 证据等级

- 代码验证：已完成。
- 隔离测试数据验证：已完成。
- 真实环境验证：无。
- 尚未验证：真实 ESI schema 变更、真实响应中的极端数值和未知新增字段。
