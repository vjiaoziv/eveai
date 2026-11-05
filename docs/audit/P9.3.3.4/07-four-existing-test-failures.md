# P9.3.3.3 原有四项失败调查

## 1. 原始失败清单

历史报告 `docs/audit/P9.3.3.3/10-tests-and-quality-gates.md` 记录的唯一失败文件为 `tests/unit/p9-3.3.3-asset-race.test.ts`：

1. `FINDING: asset sync must reject a characterId that contradicts the pinned user context`
2. `FINDING: canonical hash must not dedupe away location_type/is_singleton/blueprint-copy changes`
3. `FINDING: two processes must not both pass RUNNING check and let an older response overwrite the newer snapshot`
4. `FINDING: asset sync must abort when the pinned character is unlinked during the ESI response`

它们分别对应 F-P9333-03、F-P9333-02、F-P9333-01、F-P9333-04，不是四个互不相关的偶然失败。

## 2. 根因与处理

| 失败项 | 原根因 | 处理 |
|---|---|---|
| signed context conflict | 入口未比较 target 与 pinned ctx | 入口严格校验，并验证 token/capability 角色 |
| canonical hash | 语义字段遗漏 | 版本 1 hash + 跨版本去重保护 |
| two-process race | 非原子 RUNNING 查询与插入，无 generation fencing | BEGIN IMMEDIATE ownership + unique index + final fencing checks |
| unlink race | 仅在 ESI 前校验绑定 | binding epoch/digest + 最终事务内复核 |

## 3. 测试自身问题

修复早期曾发现两个夹具问题：`better-sqlite3` 不接受 `20_000` 作为 PRAGMA 字面量，迁移测试缺少 `telegram_sessions`/`eve_accounts` 外键父行。它们被明确归类为测试夹具问题并修正，没有改变业务断言。

双进程测试的屏障也经过调整：不再在 acquisition transaction 内等待文件，而是在 B 已持有持久 lease 并进入 ESI fetch 后发信号；A 再执行原子申请并失败。这样既形成确定性交错，也避免持锁等待造成误判。

## 4. 复验

- 历史反例文件：4/4 通过；
- 历史反例纳入关键并发联合组连续运行 3 次：每次 22/22；
- 完整门禁再次运行：2228/2228 通过，原四项失败未复现。

## 5. 分类结论

- F-P9333-01：数据库事务/并发缺陷；
- F-P9333-02：产品逻辑缺陷；
- F-P9333-03：身份授权缺陷；
- F-P9333-04：身份授权与事务时序缺陷。

没有把历史失败标记为“flaky”后忽略；原始报告和失败断言均保留。
