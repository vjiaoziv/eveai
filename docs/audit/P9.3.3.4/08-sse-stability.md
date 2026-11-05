# Perimeter Radar SSE 稳定性

## 1. 历史现象

P9.3.3.3 首次全量运行中出现：

```text
tests/integration/perimeter-radar.test.ts
Perimeter live radar, end to end over real SSE
does not lose a kill that lands before the first bubble, nor publish a bubble the pilot jumped out of
Error: jump location failed: timed out waiting for jump location
```

该文件后续隔离运行通过，因此历史报告将其记录为负载相关的不稳定测试，而不是已确认的产品缺陷。

## 2. 测试基础设施分析

该测试使用：

- 真实 Fastify HTTP server；
- 真实 HTTP socket 上的 SSE；
- 真实 EVE-KILL poller/index 路径；
- Vitest fake timers；
- 脚本化 ESI、feed 和模型边界；
- `setImmediate`/短 real-time yield 帮助 socket I/O 与 fake timer 回调推进；
- `advanceUntil()` 在声明超时前提供真实 I/O 窗口；
- 每个用例显式关闭 client 并等待 live session 归零。

失败点是 fake timer 已推进后，SSE frame 尚未通过真实 socket 可观察。没有证据表明事件未发送或 close handler 缺失；历史失败更像全量负载下的调度/I/O 可见性竞争。

## 3. 本轮处理

本轮没有延长测试乘积超时、没有跳过测试、没有降低断言，也没有为“消除失败”修改 SSE 产品逻辑。

执行结果：

- 隔离连续 3 次：每次 `1 file / 5 tests` 全部通过；
- 完整 `npm test`：该文件通过，全量 251 文件、2228 测试全部通过。

## 4. 残余风险

历史超时只出现过一次，本轮不能从统计上证明永远稳定。SSE 测试同时依赖 fake timers、真实 socket 和并行测试负载，仍应在第三轮独立审计和 CI 重复运行中观察。

## 5. 结论

未复现产品缺陷；当前证据支持测试在当前环境下的稳定性，但保留“负载相关测试基础设施风险”标签，不把它宣称为数学意义上的无竞态证明。
