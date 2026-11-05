# 19 测试证据与质量门禁

## 1. 本轮独立专项

命令：

```sh
npx vitest run tests/audit/p9-3.3.9 --reporter=verbose
```

结果：

- 13 files。
- 48 tests。
- 46 passed。
- 2 failed。
- 0 skipped。
- exit code `1`。

日志：`logs/60-p9339-full-suite.log`。

报告生成后再次复跑，仍为 13 files / 48 tests、46 passed、2 failed，失败项和根因完全一致；日志：`logs/61-p9339-full-suite-post-reports.log`。

两项失败不是 flake：

1. F-P9339-01：scope refresh 后 latest snapshot 唯一约束失败。
2. F-P9339-02：record-scoped 审计历史参数错位。

专项复现日志：`logs/40-asset-scope-refresh-repro.log`。

## 2. 历史回归

| 套件 | 文件 | 测试 | 结果 | 日志 |
|---|---:|---:|---|---|
| P9.3.3.7 | 6 | 35 | PASS | `logs/11-p9337-history-suite.log` |
| P9.3.3.8 | 8 | 25 | PASS | `logs/12-p9338-history-suite.log` |
| P9.3.3.1–P9.3.3.6 | 29 | 139 | PASS | `logs/13-p9331-p9336-history-suite.log` |

## 3. 完整项目测试

命令：

```sh
npm test
```

结果：

- 296 files。
- 2441 tests。
- 2439 passed。
- 2 failed。
- 0 skipped。
- exit code `1`。

日志：`logs/22-npm-test.log`。

失败项与专项失败完全一致，说明两个缺陷位于当前生产代码路径，不是审计测试环境独有。

## 4. 质量门禁

| 命令 | 结果 | 日志 |
|---|---|---|
| `npm run typecheck` | PASS，exit 0 | `logs/20-typecheck.log` |
| `npm run web:check` | PASS，exit 0 | `logs/21-web-check.log` |
| `npm test` | FAIL，exit 1，2 tests failed | `logs/22-npm-test.log` |
| `npm run lint` | PASS，exit 0 | `logs/24-lint.log` |
| `npm run build` | PASS，exit 0 | `logs/23-build.log` |
| `npm run audit:public` | PASS，exit 0 | `logs/25-audit-public.log` |
| `git diff --check` | PASS，exit 0 | `logs/26-diff-check.log` |
| `git diff --cached --check` | PASS，exit 0 | 同上 |

Build warning：

- `web/dist/assets/index-CbFpsH5z.js` 为 `744.95 kB`，gzip `211.99 kB`。
- Vite 报告 chunk 大于 500 kB。
- 该 warning 未被隐藏，也不是测试失败原因。

## 5. 结果解释

不能写“所有质量门禁通过”。准确表述是：

- 类型检查、Web 检查、lint、build、public artifact audit 和 whitespace check 通过。
- 完整测试失败，且失败项是两个独立确认的产品缺陷，因此总体质量门禁不通过。
- 不得通过修改断言、跳过测试、增加 timeout 或放宽数据库触发器来伪造通过。

## 6. 证据等级

- 代码验证：已完成。
- 隔离测试数据验证：已完成。
- 真实环境验证：无。
- 尚未验证：真实 EVE 环境、生产数据库、真实浏览器视觉和高负载性能。

