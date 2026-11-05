# 13 质量门禁

## 最终结果

以下命令均在本阶段最终改动完成后顺序执行，且真实退出码为 0。

| 门禁 | 结果 | 实测耗时 | 关键输出 |
|---|---:|---:|---|
| `npm run typecheck` | PASS | 7s | `tsc --noEmit` |
| `npm run web:check` | PASS | 5s | `tsc -p web/tsconfig.json --noEmit` |
| `npm test` | PASS | 148s | 265 files / 2305 tests passed |
| `npm run lint` | PASS | 5s | 0 warnings |
| `npm run build` | PASS | 15s | 服务端编译 + Vite build 成功 |
| `npm run audit:public` | PASS | <1s | `Public artifact audit passed.` |
| `git diff --check` | PASS | <1s | 无输出 |

`build` 只有 Vite 的 chunk size warning（主 JS 约 614 kB），不是失败，未通过修改规则掩盖。

## 专项回归

| 范围 | 文件 | 测试 | 结果 |
|---|---:|---:|---:|
| P9.3.3.6 专项 | 8 | 57 | 57 passed |
| P9.3.3.1..P9.3.3.5 历史反例 | 33 | 171 | 171 passed |
| 安全/REAL-PAPER/ESI 只读 | 6 | 31 | 31 passed |

## 并行工作区事件

最终门禁期间，另一个活动线程正在同一工作区完成 i18n 整改，并新增未跟踪测试。其完成后全量测试为 265/2305 通过；随后 `web:check`/`build` 发现 `App.tsx` 的 `RequestObserver` 使用组件作用域外的 `t`。已做最小修复（在该组件内调用 `useI18n()`），相关 i18n 与交易界面契约测试 13/13 通过，然后从头重跑全部最终门禁并取得上表的 0 退出码结果。

没有删除测试、跳过测试、放宽断言或关闭 lint/type 规则。

## 证据边界

以上是代码验证和隔离 SQLite/测试数据验证。没有生产数据库、真实 EVE 账号或真实 ESI 钱包数据验证。

## 状态

`P9_3_3_6_FIXES_COMPLETE`

该状态只表示本阶段修复和质量门禁完成，不表示 P9.3.3.7 独立对抗性审计通过，也不表示 `REAL_ACCOUNTING_OPERATIONALLY_VERIFIED`。
