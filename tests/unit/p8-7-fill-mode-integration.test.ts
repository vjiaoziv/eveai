import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import { PaperTradingSystem } from '../../src/trading/paper-trading.js';

function db(): Database.Database {
  const database = new Database(':memory:');
  runMigrations(database);
  PaperTradingSystem.getOrCreateAccount(database, 7001, 10_000_000);
  return database;
}

describe('P8.7 paper execution honors graded fill modes', () => {
  it('Mode B refuses a queued limit order and records no invented fill', () => {
    const database = db();
    const order = PaperTradingSystem.createVirtualOrder(database, {
      characterId: 7001,
      typeId: 34,
      strategyType: 'station_arbitrage',
      orderType: 'buy',
      price: 11,
      quantity: 8,
      fillMode: 'limit_queue',
    });
    const queued = PaperTradingSystem.executeVirtualOrderAgainstBook(
      database,
      order.orderId!,
      [{ price: 10, volumeRemain: 5 }],
      undefined,
      { mode: 'limit_queue', visibleQueueAheadQty: 1 },
    );
    expect(queued.filledQty).toBe(0);
    expect(queued.status).toBe('open');
    expect(database.prepare('SELECT COUNT(*) AS n FROM paper_fills WHERE order_id = ?').get(order.orderId)).toEqual({ n: 0 });

    const marketable = PaperTradingSystem.executeVirtualOrderAgainstBook(
      database,
      order.orderId!,
      [{ price: 10, volumeRemain: 5 }],
      undefined,
      { mode: 'limit_queue', visibleQueueAheadQty: 0 },
    );
    expect(marketable.filledQty).toBe(5);
    expect(marketable.status).toBe('partially_filled');
    const fill = database.prepare('SELECT basis, model_version FROM paper_fills WHERE order_id = ?').get(order.orderId) as any;
    expect(fill.basis).toBe('marketable_limit_queue');
    expect(fill.model_version).toBe('eveai-paper-fill-v1-limit-queue');
    database.close();
  });

  it('Mode C applies deterministic quantity and price stress', () => {
    const database = db();
    const order = PaperTradingSystem.createVirtualOrder(database, {
      characterId: 7001,
      typeId: 34,
      strategyType: 'trend_following',
      orderType: 'buy',
      price: 10,
      quantity: 10,
      fillMode: 'stress',
    });
    const result = PaperTradingSystem.executeVirtualOrderAgainstBook(
      database,
      order.orderId!,
      [{ price: 10, volumeRemain: 10 }],
      undefined,
      { mode: 'stress', maxFillRatio: 0.4, adversePriceBps: 100 },
    );
    expect(result.filledQty).toBe(4);
    expect(result.avgPrice).toBe(10.1);
    expect(result.status).toBe('partially_filled');
    const fill = database.prepare('SELECT basis, model_version, price FROM paper_fills WHERE order_id = ?').get(order.orderId) as any;
    expect(fill.basis).toBe('stress_worsened_book');
    expect(fill.model_version).toBe('eveai-paper-fill-v1-stress');
    expect(fill.price).toBe(10.1);
    database.close();
  });
});