# 质量门禁独立复核

## 1. 命令结果

执行日期：2026-11-04（Asia/Shanghai）。

| 命令 | 退出码 | 实测耗时 | 结果 |
|---|---:|---:|---|
| `npm run typecheck` | 0 | 14.03 s | 通过 |
| `npm run web:check` | 0 | 13.82 s | 通过 |
| `npm test` | 0 | 146.52 s | 255 文件，2238/2238 通过 |
| `npm run lint` | 0 | 12.69 s | 通过 |
| `npm run build` | 0 | 21.91 s | 通过，1 个 Vite chunk warning |
| `npm run audit:public` | 0 | 0.86 s | Public artifact audit passed |
| `git diff --check` | 0 | 0.27 s | 通过 |

## 2. 全量测试统计

- Test Files：255 passed（255）
- Tests：2238 passed（2238）
- 失败：0
- 跳过：0（输出未报告 skipped）
- Vitest Duration：145.11 s

P9.3.3.4 报告的 251/2228 与当前 255/2238 差异来自新增审计文件和测试；没有删除历史测试来对齐数量。

## 3. P9.3 专项统计

显式传入 27 个 `tests/unit/p9-3*.test.ts`：

- 27/27 files passed
- 154/154 tests passed

一次 PowerShell 通配符调用因未由 shell 展开而返回 Vitest `No test files found`（退出码 1），随后用显式文件列表重跑并通过。该调用是命令拼接问题，不是项目测试失败，已如实保留。

## 4. Build 警告

Vite 报告：

`web/dist/assets/index-HFnpYwiR.js 610.83 kB (gzip: 172.64 kB)`，超过 500 kB 建议阈值。

这是性能/打包 warning，不是本次失败的直接原因；未通过调高阈值或关闭规则掩盖。

## 5. 结论

质量门禁全部通过，但由于独立反例已经复现 P1，不能使用门禁通过来改变最终审计状态。

## 6. 证据等级

- 本地 WSL 隔离环境：已验证。
- CI/生产同等环境、生产构建产物部署：未验证。

## 7. 完成审计最终复核

2026-11-04 在报告定稿后再次执行当前工作区的门禁：

- `npm run typecheck`、`npm run web:check`、`npm run lint`、`npm run audit:public`：全部退出码 0。
- `npm test`：255 个文件、2238/2238 项通过。
- `npm run build`：通过，仍仅有 `web/dist/assets/index-HFnpYwiR.js` 610.83 kB 的 Vite chunk warning。
- 关键协调器/fencing/hash/context/unbind/migration 7 文件组：28/28，连续 5/5 次通过。
- 五进程资产所有权竞争：1/1，连续 5/5 次通过。
- `tests/integration/perimeter-radar.test.ts`：5/5，连续 5/5 次通过。

最终复核时首次把 SSE 文件误写为不存在的 `tests/unit/perimeter-radar.test.ts`，Vitest 返回 `No test files found`。更正为实际路径 `tests/integration/perimeter-radar.test.ts` 后连续 5 次通过；这是命令路径错误，不是测试失败，也未据此修改断言或放宽规则。
