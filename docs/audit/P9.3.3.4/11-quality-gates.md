# 质量门禁

## 1. 执行环境

- WSL 发行版：Ubuntu-24.04
- 仓库：`/home/ubuntu/projects/eveai`
- Node/Vitest：Vitest `v4.1.11`
- 数据库：隔离内存/临时 SQLite

## 2. 门禁结果

| 命令 | 结果 | 证据 |
|---|---|---|
| `npm run typecheck` | 通过 | `tsc --noEmit`，exit 0 |
| `npm run web:check` | 通过 | web TS `--noEmit`，exit 0 |
| `npm test -- --reporter=dot` | 通过 | 251 文件，2228/2228，0 failed，0 skipped，132.02s |
| `npm run lint` | 通过 | ESLint `--max-warnings 0`，exit 0 |
| `npm run build` | 通过 | tsc + Vite 235 modules；exit 0 |
| `npm run audit:public` | 通过 | `Public artifact audit passed.` |
| `git diff --check` | 通过 | exit 0，无 whitespace error |

## 3. 专项重复结果

| 测试组 | 次数 | 每次结果 |
|---|---:|---|
| `perimeter-radar.test.ts` | 3 | 1 file / 5 tests passed |
| job atomicity + fencing + unbind + canonical hash + 历史反例 | 3 | 5 files / 22 tests passed |
| 全部 P9.3.3.4 + 历史资产测试联合组 | 1 | 8 files / 37 tests passed |

## 4. 构建警告

Vite 报告：

```text
Some chunks are larger than 500 kB after minification.
web/dist/assets/index-*.js 610.83 kB (gzip 172.64 kB)
```

这是构建成功后的 bundle-size 警告，不是编译或测试失败。本轮没有为消除提示改动前端拆包，因为它超出 P9.3.3.4 范围。

## 5. 失败与跳过

- 失败测试：0；
- 跳过测试：0；
- 删除测试：0；
- 降低断言：0；
- 使用 `skip`/`todo` 规避：0；
- 生产数据库写入：0；
- Git commit/push/deploy：0。

## 6. 证据边界

以上为代码检查和隔离测试证据，不是生产或真实 EVE 账户验证。验收命令均已实际执行，结果来自本次会话输出。
