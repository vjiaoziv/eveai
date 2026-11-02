# P8.7 测试结果

执行日期：2026-11-02（Asia/Shanghai）

## 新增测试

| 文件 | 用例 | 结果 |
|---|---:|---:|
| `tests/unit/p8-7-fill-recording.test.ts` | 2 | PASS |
| `tests/unit/p8-7-fill-modes.test.ts` | 2 | PASS |
| `tests/unit/p8-7-fill-mode-integration.test.ts` | 2 | PASS |
| `tests/unit/p8-7-performance-runtime.test.ts` | 4 | PASS |

覆盖：逐档 fill、深度不足、重复执行幂等、Mode B 排队、Mode C 压力、四层利润、FIFO、账本对平、深度估值、零分母、运行门禁、未来数据泄漏。

## 全量门禁

原始结果：

```text
npx vitest run
Test Files  215 passed (215)
Tests       2019 passed (2019)
Duration    284.52s

npm run typecheck
PASS

npm run web:check
PASS

npm run lint
PASS

npm run build
PASS
vite build: 231 modules transformed
```

构建仅有既有的单 chunk 超过 500 kB 警告，不影响构建成功。

## 保留的安全测试

P8.5.6 的并发、ESI 只读、签名撤销、订单簿深度、资金冻结等测试均未删除或弱化，并包含在全量 2019 个通过用例中。