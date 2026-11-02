import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import { PaperTradingSystem } from '../../src/trading/paper-trading.js';

describe('P8.7 paper fill recording', () => {
  it('records one row per orderbook level with fees and remaining quantity', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    PaperTradingSystem.getOrCreateAccount(db, 5001, 10_000_000);
    const order = PaperTradingSystem.createVirtualOrder(db, {
      characterId: 5001,
      typeId: 34,
      strategyType: 'station_arbitrage',
      orderType: 'buy',
      price: 10,
      quantity: 100,
      opportunityId: 'OPP-FILL-001',
      snapshotId: 'MSNAP-FILL-001',
    });

    const result = PaperTradingSystem.executeVirtualOrderAgainstBook(db, order.orderId!, [
      { price: 10, volumeRemain: 40 },
      { price: 11, volumeRemain: 60 },
    ]);

    const fills = db.prepare(
      'SELECT fill_id, opportunity_id, snapshot_id, price, quantity, fees, remaining_quantity, basis, model_version FROM paper_fills WHERE order_id = ? ORDER BY filled_at, rowid',
    ).all(order.orderId!) as any[];
    const totalFillQty = fills.reduce((sum, row) => sum + row.quantity, 0);
    const totalFillFees = fills.reduce((sum, row) => sum + row.fees, 0);
    const orderRow = db.prepare('SELECT fees_paid FROM paper_trading_orders WHERE order_id = ?').get(order.orderId!) as any;

    expect(result.filledQty).toBe(100);
    expect(fills).toHaveLength(2);
    expect(totalFillQty).toBe(100);
    expect(fills[0]).toMatchObject({
      opportunity_id: 'OPP-FILL-001',
      snapshot_id: 'MSNAP-FILL-001',
      price: 10,
      quantity: 40,
      basis: 'counterparty_orderbook_level',
      model_version: 'eveai-paper-fill-v1-immediate',
    });
    expect(fills[0].remaining_quantity).toBe(60);
    expect(fills[1].remaining_quantity).toBe(0);
    expect(Math.round(totalFillFees * 100) / 100).toBe(Math.round(orderRow.fees_paid * 100) / 100);
    db.close();
  });

  it('does not invent a fill when counterparty depth is missing and is idempotent on replay', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    PaperTradingSystem.getOrCreateAccount(db, 5001, 10_000_000);
    const order = PaperTradingSystem.createVirtualOrder(db, {
      characterId: 5001,
      typeId: 34,
      strategyType: 'station_arbitrage',
      orderType: 'buy',
      price: 10,
      quantity: 50,
      snapshotId: 'MSNAP-EMPTY',
    });

    const empty = PaperTradingSystem.executeVirtualOrderAgainstBook(db, order.orderId!, []);
    expect(empty.filledQty).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM paper_fills WHERE order_id = ?').get(order.orderId!)).toEqual({ n: 0 });

    const firstFill = PaperTradingSystem.executeVirtualOrderAgainstBook(db, order.orderId!, [{ price: 10, volumeRemain: 50 }]);
    const replayFill = PaperTradingSystem.executeVirtualOrderAgainstBook(db, order.orderId!, [{ price: 10, volumeRemain: 50 }]);
    expect(firstFill.filledQty).toBe(50);
    expect(replayFill.filledQty).toBe(0);
    expect(replayFill.status).toBe('filled');
    expect(db.prepare('SELECT COUNT(*) AS n FROM paper_fills WHERE order_id = ?').get(order.orderId!)).toEqual({ n: 1 });
    db.close();
  });
});
