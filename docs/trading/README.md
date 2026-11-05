# Trading Documentation

Status: active
Baseline: 2026-11-02
Last organized: 2026-11-04

These documents describe the trading domain's architecture, accounting rules,
risk controls, data sources, strategies, and operator workflows. They are
design and operational references, not proof that current runtime behavior still
matches them; verify behavior against code and tests before acting.

## Architecture And Controls

- [trading-system-architecture.md](./trading-system-architecture.md): runtime layers, module contracts, and deployment topology.
- [ai-agent-design.md](./ai-agent-design.md): deterministic-calculation versus AI-reasoning roles and response layers.
- [portfolio-risk-model.md](./portfolio-risk-model.md): capital accounting and hard portfolio limits.
- [known-limitations.md](./known-limitations.md): ESI, game-mechanic, and operator boundaries.

## Market And Accounting

- [market-data-sources.md](./market-data-sources.md): ESI, SDE, and fallback-source ownership.
- [fee-calculation.md](./fee-calculation.md): broker, sales, relist, and facility-fee formulas.
- [trading-data-dictionary.md](./trading-data-dictionary.md): trading tables and their fields.

## Strategy, Backtesting, And Use

- [trading-strategies.md](./trading-strategies.md): strategy definitions and qualifying conditions.
- [backtesting-guide.md](./backtesting-guide.md): no-lookahead backtesting and paper-trading behavior.
- [trading-user-guide.md](./trading-user-guide.md): browser and CLI workflows for operators.
