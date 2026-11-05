# Audit Archive

Status: active
Last organized: 2026-11-04

This directory is the system of record for phase-scoped audit reports. Historical
reports moved from the repository root retain their original filenames so that
references and Git rename history remain traceable.

## Archived Reports

- [pre-P8](./pre-P8/): baseline capability, independent audit, defect, security, implementation, installation, and deployment records.
- [P8](./P8/): initial trading-system reconstruction, validation, and final acceptance reports.
- [P8.5](./P8.5/): independent re-audit, timestamp/causality checks, remediation, and acceptance.
- [P8.5.1](./P8.5.1/): paper-trading readiness, valuation, reliability, and acceptance.
- [P8.5.2](./P8.5.2/): deep code, security, accounting, order-state, and strategy audits.
- [P8.5.3](./P8.5.3/): concurrency, idempotency, credentials, database recovery, and regression reports.

## Later Audit Phases

- [P8.5.4](./P8.5.4/): independently structured P8.5.4 audit.
- [P8.5.5](./P8.5.5/): credential, HMAC, key-management, replay, and ledger audit.
- [P8.5.6](./P8.5.6/): final blocker clearance, ESI read-only, concurrency, and recovery acceptance.
- [P8.7](./P8.7/): paper-fill, opportunity-quality, strategy, and dashboard validation.
- [P9](./P9/): architecture, deployment, market data, risk control, and user-guide reports.
- [P9.1.1](./P9.1.1/): market-refresh and restart root-cause verification.
- [P9.2](./P9.2/): ESI asset-sync, data model, valuation, security, and production verification.
- [P9.3](./P9.3/): transaction ledger, evidence, FIFO, PnL, and reconciliation design.
- [P9.3.1](./P9.3.1/): real-accounting evidence and verification.
- [P9.3.2](./P9.3.2/): deployment record, backup/restore, version, and boundary verification.
- [project-audit-20261103](./project-audit-20261103/): whole-project functional, security, financial, UI, test, deployment, and risk audit.

## Reading Rule

Start with a phase final-verdict, final-acceptance, or unresolved-risks document,
then follow links or filenames into the supporting audits. Audit reports describe
the state at their recorded point in time; current behavior must still be verified
against code and tests.
