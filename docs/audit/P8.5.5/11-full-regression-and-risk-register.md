# P8.5.5 全项目测试与风险清单

## 真实执行

执行命令：

~~~text
npx vitest run
npm run typecheck
npm run build
npm run lint
~~~

日志：

- docs/audit/P8.5.5/logs/full-vitest.log
- docs/audit/P8.5.5/logs/full-vitest-rerun.log
- docs/audit/P8.5.5/logs/p8-5-5-targeted.log

基线 HEAD：c7e3fa74663303624c63193016555dcd8accb20a；P8.5.5 最终提交：the current P8.5.5 HEAD (resolve with git rev-parse HEAD)。

## 结果

全项目回归：

- 测试文件：205。
- 测试用例：1998。
- 通过：1995。
- 失败：3。
- 耗时：26.72 秒。
- 通过率：99.85%。

失败项：

1. tests/integration/perimeter-radar.test.ts：并行运行时 poller stopped 等待超时。
2. tests/integration/perimeter-radar.test.ts：另一场景同样 poller stopped 等待超时。
3. tests/unit/eve-kill-feed-poll.test.ts：SQLite restart 测试 5 秒超时。

单独运行结果：

- perimeter-radar.test.ts：5/5 通过。
- eve-kill-feed-poll.test.ts：16/16 通过。
- map-route-clear.test.ts：3/3 通过。

map-route-clear 原失败已通过在 buildBubble 前对未知 origin/destination 快速失败修复。perimeter 与 kill-feed 在默认并行执行下仍有 flaky/超时，不能以单跑通过替代全量绿灯。

TypeScript：通过。

Build：通过；Vite 有字体 woff2 运行时解析警告，产物生成成功。

Lint：通过，0 errors / 0 warnings。

## 历史四项失败复核

- perimeter-radar.test.ts：未完全修复，单独通过、并行失败。
- eve-kill-feed-poll.test.ts：未完全修复，单独通过、并行失败。
- prompts.test.ts：通过 7/7。
- sde-schema-hint.test.ts：通过 4/4。

没有删除测试、没有 .skip、没有降低断言、没有增加大超时掩盖。

## 风险登记

### P0

- 未发现资产写接口。
- 旧硬编码签名密钥已从工作树移除，但 Git 历史中仍存在；必须视为泄露并弃用。若生产曾使用该密钥，应作为 P0 凭证泄露事件处理。

### P1

1. ESI 运行时并非严格只读：post_ui_autopilot_waypoint 与 post_ui_openwindow_* 可由 callEsiOperation 派发。
2. 默认并行全量回归仍有 3 项 flaky/timeout，不能满足“全项目测试真实完整通过”。
3. feeModelVersion、独立 marketSnapshotId、买/卖快照精确时间戳未绑定到凭证。
4. 100 ISK broker fee 绝对保底缺少权威 CCP 当前来源。
5. 历史 paper_trading_orders 没有担保金列回填迁移。

### P2

- Build 有字体资源解析警告。
- A22 是同步压力而非真实并发。
- realized_pnl journal 类型没有在成交路径独立写入。
- UI POST 的产品边界需要文档化，明确哪些非资产副作用由人工确认。

## 结论

核心交易凭证和账本修复通过专项测试，但 P1 风险未清零，最终状态必须是 PAPER_TRADING_BLOCKED。
