# P8.5.6 风险登记

## P0

0。

没有真实资产写路径；最终 ESI 网关仅允许 GET。

## P1

0。

R01-R08 均有代码、测试和日志证据。

## P2

1. 严格 GET-only 使 post_universe_names、post_universe_ids、post_characters_affiliation 等只读 POST lookup 也返回 405；产品层需要使用本地 SDE/GET 数据源逐步替代。
2. 全量回归为保证全局 fake-timer/SSE 测试稳定，采用串行文件执行；这验证稳定性但不代表高并发 CI 性能。

## 控制与残余不确定性

- 历史密钥仍在 Git 历史中，但运行时指纹撤销。
- SSO OAuth POST 不属于 ESI 资产写网关；其登录服务仍允许必要的 POST。
- 真实 EVE 市场成交能力不在 Paper Trading 验收范围内。
