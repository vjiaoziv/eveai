# 测试报告

## 1. 最终全量门禁

**已通过隔离测试数据验证**

执行：

```text
npm run check
```

结果：

- `tsc --noEmit`：通过。
- `npm run web:check`：通过。
- `vitest run`：230/230 测试文件通过，2124/2124 测试通过。
- `eslint src/ web/src/ --max-warnings 0`：通过。
- 命令退出码：0。

初次最终全量运行发生在最后一次资产文案修正、最终构建和生产部署之前；之后单独执行了 `npm run web:check`、`asset-routes.test.ts`、专项组合测试、最终构建和生产浏览器重载，均通过。
最终全量运行发生在最后一次资产文案修正、最终构建和生产部署之前；报告标签规范化后于 2026-11-04 04:40 CST 再次执行完整 `npm run check`，仍为 230/230 文件、2124/2124 测试通过，退出码 0。

## 2. 专项组合测试

**已通过隔离测试数据验证**

执行以下 20 个文件：

```text
tests/unit/p9-3-hardening.test.ts
tests/unit/p9-3-real-accounting.test.ts
tests/unit/p9-core-workflow.test.ts
tests/unit/p9-safety-and-ai.test.ts
tests/unit/p9-trading-screen-contract.test.ts
tests/unit/p8-5-6-esi-readonly-gateway.test.ts
tests/unit/p8-7-paper-role-isolation.test.ts
tests/unit/paper-routes-isolation.test.ts
tests/unit/asset-history.test.ts
tests/unit/asset-inventory.test.ts
tests/unit/asset-opportunity-match.test.ts
tests/unit/asset-routes.test.ts
tests/unit/asset-sync.test.ts
tests/unit/asset-valuation.test.ts
tests/unit/web-security.test.ts
tests/unit/web-security-tier.test.ts
tests/unit/web-session-revocation.test.ts
tests/unit/character-sql-security.test.ts
tests/unit/sde-sql-security.test.ts
tests/integration/perimeter-radar.test.ts
```

结果：

- 20/20 测试文件通过。
- 189/189 测试通过。
- 覆盖：P9.3 财务边界、REAL/PAPER 隔离、ESI GET-only、AI 写入阻断、证据冲突、FIFO/PnL、资产同步/估值/对账、认证/会话、SQL 安全、Perimeter SSE。

## 3. `perimeter-radar.test.ts` 时间敏感失败调查

**已通过隔离测试数据验证**

根因：测试在假时钟推进后立即读取真实 SSE socket；业务轮询使用假时钟，而网络 I/O 仍使用真实事件循环，造成测试断言与 socket 写入/读取之间的时序竞争。不是已复现的业务逻辑缺陷。

修复：等待首次成功轮询，并在推进假时钟后等待真实 I/O 完成。没有删除测试、跳过用例、放宽业务断言或修改生产业务逻辑来掩盖失败。

重复验证：

- 单次完整文件：5/5 tests passed。
- 连续 10 次完整文件运行：10/10 次通过，每次测试文件均为 passed。
- 最终全量 `npm run check` 中该文件同样通过。

## 4. 构建与依赖

**已通过真实环境验证**

```text
npm run build
```

结果：成功。Vite 构建 234 modules；主 JS `608.20 kB`（gzip `172.13 kB`），CSS `129.68 kB`（gzip `20.88 kB`）。仅有单 chunk 大于 500 kB 的性能警告。

```text
npm audit --omit=dev
```

结果：`found 0 vulnerabilities`。

```text
git diff --check
```

结果：通过，无 whitespace error。

## 5. 补充验证

**已通过真实环境验证**

- 生产 `/health` HTTP 200，database ok，web_agent_queue queued/running/stale 均为 0。
- 生产 `/app` canonical 302 后 200。
- 4 个未认证 REAL 路由返回 401。
- 生产 served JS/CSS 的 SHA-256 与本地最终文件一致。
- 生产数据库 `quick_check=ok`，外键违规 0。

## 6. 工具限制

**尚未验证**

- Codex Security 扫描工具不可用：`Could not read local file: node_modules\.bin\acorn`。
- 因此没有执行完整自动化安全扫描；替代证据见 `03-security-boundaries.md`。
- 没有自动化浏览器视觉回归基线；视觉结论来自实际浏览器只读检查。
- 没有低端设备 CPU/网络节流下的性能基准，不声称 Core Web Vitals 已通过。
