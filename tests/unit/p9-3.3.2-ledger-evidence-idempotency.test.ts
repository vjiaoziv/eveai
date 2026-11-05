import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import type { Db } from '../../src/db/sqlite.js';
import { P93LedgerService } from '../../src/trading/p9-3-ledger-service.js';

const USER_ID = 9320001;
const CHAR_A = 9320101;
const CHAR_B = 9320102;
let db: Database.Database;

function record(characterId = CHAR_A, key = 'evidence-idempotency') {
  return P93LedgerService.recordManual(db as Db, characterId, {
    ledgerKey: key,
    tradeKind: 'BUY',
    direction: 'BUY',
    typeId: 34,
    locationId: 60003760,
    quantity: 1,
    unitPrice: 10,
    tradeTime: '2026-05-01T00:00:00.000Z',
    sourceType: 'USER_MANUAL_ENTRY',
    feeStatus: 'COMPLETE',
  }, 'user:test');
}

function evidence(characterId = CHAR_A, suffix = 'single') {
  return P93LedgerService.addEvidence(db as Db, characterId, {
    evidenceType: 'USER_CONFIRMATION',
    sourceSystem: 'USER_CONFIRMATION',
    sourceRef: `manual-evidence-${suffix}`,
    capturedAt: '2026-05-01T00:00:00.000Z',
    payloadHash: `payload-${suffix}`,
    summary: 'isolated evidence idempotency test',
    initialStatus: 'PENDING',
  }, 'USER');
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare('INSERT INTO users (user_id, display_name, active_character_id) VALUES (?, ?, ?)')
    .run(USER_ID, 'Evidence Audit', CHAR_A);
});

afterEach(() => db.close());

describe('P9.3.3.2 evidence-link idempotency', () => {
  it('creates one relation and one event for repeated and concurrent identical links', async () => {
    const trade = record();
    const item = evidence();
    const args = [db as Db, CHAR_A, trade.recordId, item.evidenceId, 'PRIMARY', 'HIGH'] as const;

    P93LedgerService.linkEvidence(...args);
    P93LedgerService.linkEvidence(...args);
    await Promise.all([
      Promise.resolve().then(() => P93LedgerService.linkEvidence(...args)),
      Promise.resolve().then(() => P93LedgerService.linkEvidence(...args)),
    ]);

    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_evidence_links').get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM real_trade_events WHERE event_type = 'evidence_linked'").get())
      .toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM real_trade_events WHERE event_type = 'evidence_link_updated'").get())
      .toEqual({ n: 0 });
  });

  it('writes one update event only when the relation actually changes', () => {
    const trade = record(CHAR_A, 'evidence-link-update');
    const item = evidence(CHAR_A, 'update');

    P93LedgerService.linkEvidence(
      db as Db, CHAR_A, trade.recordId, item.evidenceId, 'PRIMARY', 'HIGH',
    );
    P93LedgerService.linkEvidence(
      db as Db, CHAR_A, trade.recordId, item.evidenceId, 'CORROBORATING', 'MEDIUM', 'updated relation',
    );
    P93LedgerService.linkEvidence(
      db as Db, CHAR_A, trade.recordId, item.evidenceId, 'CORROBORATING', 'MEDIUM', 'updated relation',
    );

    expect(db.prepare('SELECT relation, confidence, notes FROM real_trade_evidence_links').get()).toEqual({
      relation: 'CORROBORATING',
      confidence: 'MEDIUM',
      notes: 'updated relation',
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM real_trade_events WHERE event_type = 'evidence_link_updated'").get())
      .toEqual({ n: 1 });
  });

  it('rejects cross-character record/evidence association', () => {
    const trade = record(CHAR_A, 'cross-character-record');
    const item = evidence(CHAR_A, 'cross-character-evidence');

    expect(() => P93LedgerService.linkEvidence(
      db as Db, CHAR_B, trade.recordId, item.evidenceId, 'PRIMARY', 'HIGH',
    )).toThrow(/交易或证据不存在/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM real_trade_evidence_links').get()).toEqual({ n: 0 });
  });
});
