import Database from 'better-sqlite3';
import { PaperTradingSystem } from '../../src/trading/paper-trading.js';
import { DraftSystem } from '../../src/trading/draft-system.js';
import type { TradeOpportunity } from '../../src/trading/types.js';

type OrderArgs = {
  mode: 'orders';
  dbPath: string;
  characterId: number;
  iterations: number;
  price: number;
  quantity: number;
};

type CredentialArgs = {
  mode: 'credential';
  dbPath: string;
  characterId: number;
  attempts: number;
  opportunity: TradeOpportunity;
};

type WorkerArgs = OrderArgs | CredentialArgs;

const args = JSON.parse(process.argv[2] ?? '{}') as WorkerArgs;
const db = new Database(args.dbPath);
db.pragma('busy_timeout = 5000');

function finish(payload: Record<string, unknown>): never {
  process.stdout.write(JSON.stringify(payload));
  db.close();
  process.exit(0);
}

if (args.mode === 'orders') {
  let succeeded = 0;
  let rejected = 0;
  let conflict = 0;
  for (let index = 0; index < args.iterations; index += 1) {
    const result = PaperTradingSystem.createVirtualOrder(db, {
      characterId: args.characterId,
      typeId: 34,
      strategyType: 'station_arbitrage',
      orderType: 'buy',
      price: args.price,
      quantity: args.quantity,
      idempotencyKey: `mp-${process.pid}-${index}`,
    });
    if (result.success) succeeded += 1;
    else if (result.error?.includes('幂等冲突')) conflict += 1;
    else rejected += 1;
  }
  finish({ mode: 'orders', succeeded, rejected, conflict });
}

const opp = args.opportunity;
let succeeded = 0;
let replayed = 0;
let failed = 0;
for (let index = 0; index < Math.max(1, args.attempts); index += 1) {
  try {
    DraftSystem.createDraft(db, args.characterId, opp);
    succeeded += 1;
  } catch (error) {
    if (String((error as Error).message).includes('凭证重放阻断')) replayed += 1;
    else failed += 1;
  }
}
finish({ mode: 'credential', succeeded, replayed, failed });
