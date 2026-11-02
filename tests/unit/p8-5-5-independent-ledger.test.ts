import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import { PaperTradingSystem } from '../../src/trading/paper-trading.js';

type JournalRow = {
  journal_id: number;
  account_id: string;
  order_id: string | null;
  entry_type: 'deposit' | 'escrow_lock' | 'escrow_release' | 'fee_payment' | 'realized_pnl' | 'order_spend' | 'order_revenue';
  amount: number;
  balance_after: number;
  escrow_after: number;
};

function independentlyReplayJournal(db: Database.Database, accountId: string) {
  const rows = db.prepare(`
    SELECT journal_id, account_id, order_id, entry_type, amount, balance_after, escrow_after
    FROM paper_trading_journal
    WHERE account_id = ?
    ORDER BY journal_id
  `).all(accountId) as JournalRow[];

  const orderTypes = new Map<string, string>();
  for (const row of db.prepare('SELECT order_id, order_type FROM paper_trading_orders').all() as Array<{ order_id: string; order_type: string }>) {
    orderTypes.set(row.order_id, row.order_type);
  }

  let cash = 0;
  let escrow = 0;
  const mismatches: string[] = [];
  const reconstructed = rows.map((row) => {
    switch (row.entry_type) {
      case 'deposit':
        cash += row.amount;
        break;
      case 'escrow_lock':
        cash -= row.amount;
        escrow += row.amount;
        break;
      case 'escrow_release':
        cash += row.amount;
        escrow -= row.amount;
        break;
      case 'order_spend':
        escrow -= row.amount;
        break;
      case 'order_revenue':
        cash += row.amount;
        break;
      case 'fee_payment':
        if (row.order_id && orderTypes.get(row.order_id) === 'buy') escrow -= row.amount;
        else cash -= row.amount;
        break;
      case 'realized_pnl':
        cash += row.amount;
        break;
    }
    if (Math.abs(cash - row.balance_after) > 0.01 || Math.abs(escrow - row.escrow_after) > 0.01) {
      mismatches.push(`journal_id=${row.journal_id}: replay=${cash.toFixed(2)}/${escrow.toFixed(2)} recorded=${row.balance_after.toFixed(2)}/${row.escrow_after.toFixed(2)}`);
    }
    return { ...row, replayCash: cash, replayEscrow: escrow };
  });

  return { rows: reconstructed, cash, escrow, mismatches };
}

describe('P8.5.5 independent paper ledger reconstruction', () => {
  it('reconstructs every journal balance and releases the exact remaining escrow after partial fill', () => {
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
    expect(order.success).toBe(true);

    PaperTradingSystem.executeVirtualOrderAgainstBook(db, order.orderId!, [{ price: 100, volumeRemain: 300 }]);
    expect(PaperTradingSystem.cancelVirtualOrder(db, order.orderId!)).toBe(true);

    const replay = independentlyReplayJournal(db, 'PT-ACC-5001');
    expect(replay.mismatches).toEqual([]);
    expect(replay.cash).toBe(969_370);
    expect(replay.escrow).toBe(0);

    const inventoryCost = db.prepare(`
      SELECT COALESCE(SUM(quantity * cost_price), 0) AS cost_basis
      FROM paper_trading_positions
      WHERE character_id = 5001 AND status = 'holding'
    `).get() as { cost_basis: number };
    const fees = db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN entry_type = 'fee_payment' THEN amount ELSE 0 END), 0) AS fees
      FROM paper_trading_journal
      WHERE account_id = 'PT-ACC-5001'
    `).get() as { fees: number };

    expect(inventoryCost.cost_basis).toBe(30_000);
    expect(fees.fees).toBe(630);
    expect(replay.cash + replay.escrow + inventoryCost.cost_basis).toBe(1_000_000 - fees.fees);
    db.close();
  });
});
