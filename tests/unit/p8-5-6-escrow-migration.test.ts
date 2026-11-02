import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import { PaperTradingSystem } from '../../src/trading/paper-trading.js';

describe('P8.5.6 historical escrow migration', () => {
  it('recovers journal-backed escrow and isolates unrecoverable legacy rows idempotently', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    PaperTradingSystem.getOrCreateAccount(db, 5001, 1_000_000);
    const order = PaperTradingSystem.createVirtualOrder(db, {
      characterId: 5001,
      typeId: 34,
      strategyType: 'station_arbitrage',
      orderType: 'buy',
      price: 100,
      quantity: 1000,
    });
    PaperTradingSystem.executeVirtualOrderAgainstBook(db, order.orderId!, [{ price: 100, volumeRemain: 300 }]);

    db.prepare(`
      UPDATE paper_trading_orders
      SET escrow_locked = 0, fee_reserved = 0, escrow_migration_status = 'legacy_pending'
      WHERE order_id = ?
    `).run(order.orderId!);
    db.prepare(`
      INSERT INTO paper_trading_orders (
        order_id, account_id, character_id, type_id, strategy_type, order_type,
        price, quantity, filled_quantity, status, fees_paid, escrow_locked,
        fee_reserved, escrow_migration_status, created_at, updated_at
      ) VALUES ('PT-ORD-LEGACY-NOJOURNAL', 'PT-ACC-5001', 5001, 34, 'station_arbitrage', 'buy',
        10, 100, 0, 'open', 0, 0, 0, 'legacy_pending', datetime('now'), datetime('now'))
    `).run();

    runMigrations(db);
    const recovered = db.prepare('SELECT escrow_locked, fee_reserved, escrow_migration_status FROM paper_trading_orders WHERE order_id = ?').get(order.orderId!) as any;
    const unrecoverable = db.prepare('SELECT escrow_locked, fee_reserved, escrow_migration_status FROM paper_trading_orders WHERE order_id = ?').get('PT-ORD-LEGACY-NOJOURNAL') as any;

    expect(recovered).toEqual({
      escrow_locked: 71470,
      fee_reserved: 1470,
      escrow_migration_status: 'recovered',
    });
    expect(unrecoverable).toEqual({
      escrow_locked: 0,
      fee_reserved: 0,
      escrow_migration_status: 'unrecoverable',
    });

    runMigrations(db);
    expect(db.prepare('SELECT escrow_locked, fee_reserved, escrow_migration_status FROM paper_trading_orders WHERE order_id = ?').get(order.orderId!)).toEqual(recovered);
    expect(db.prepare('SELECT escrow_locked, fee_reserved, escrow_migration_status FROM paper_trading_orders WHERE order_id = ?').get('PT-ORD-LEGACY-NOJOURNAL')).toEqual(unrecoverable);
    db.close();
  });
});
