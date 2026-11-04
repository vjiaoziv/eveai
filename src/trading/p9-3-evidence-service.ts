import { createHash } from 'node:crypto';
import type { Db } from '../db/sqlite.js';
import type { UserContext } from '../auth/user-resolver.js';
import { callEsiOperation } from '../eve/esi-client.js';
import { P93LedgerService } from './p9-3-ledger-service.js';

export type NormalizedEsiWalletTransaction = {
  transactionId: number;
  date: string;
  typeId: number;
  quantity: number;
  unitPrice: number;
  isBuy: boolean;
  locationId: number;
};

export function normalizeEsiWalletTransaction(row: Record<string, unknown>): NormalizedEsiWalletTransaction {
  return {
    transactionId: Number(row.transaction_id),
    date: String(row.date || ''),
    typeId: Number(row.type_id),
    quantity: Number(row.quantity),
    unitPrice: Number(row.unit_price ?? row.price),
    isBuy: Boolean(row.is_buy),
    locationId: Number(row.station_id || row.location_id || 0),
  };
}

export class P93EsiEvidenceService {
  static async syncWalletTransactions(
    db: Db,
    characterId: number,
    ctx: UserContext,
  ): Promise<{ imported: number; skipped: number; verified: number; lastTransactionId: number | null; errors: string[] }> {
    const state = db.prepare('SELECT * FROM real_esi_transaction_sync WHERE character_id = ?').get(characterId) as any;
    const lastId = Number(state?.last_transaction_id || 0);
    const result = await callEsiOperation<Array<Record<string, unknown>>>(
      db,
      'get_characters_character_id_wallet_transactions',
      { character_id: characterId },
      ctx,
      { maxPages: 10 },
    );
    if (!result.ok) {
      db.prepare(`
        INSERT INTO real_esi_transaction_sync (character_id, status, error, last_synced_at)
        VALUES (?, 'error', ?, datetime('now'))
        ON CONFLICT(character_id) DO UPDATE SET status = 'error', error = excluded.error, last_synced_at = excluded.last_synced_at
      `).run(characterId, result.error);
      return { imported: 0, skipped: 0, verified: 0, lastTransactionId: lastId || null, errors: [result.error] };
    }

    const rows = Array.isArray(result.data) ? result.data : [];
    const ordered = rows.map(normalizeEsiWalletTransaction)
      .filter((row) => Number.isSafeInteger(row.transactionId) && row.transactionId > 0 && row.typeId > 0 && row.quantity > 0)
      .sort((a, b) => a.transactionId - b.transactionId);

    let imported = 0;
    let skipped = 0;
    let verified = 0;
    const errors: string[] = [];
    let newLastId = lastId;
    for (const row of ordered) {
      if (row.transactionId <= lastId) {
        skipped += 1;
        continue;
      }
      if (row.locationId <= 0 || !row.date || !Number.isFinite(row.unitPrice)) {
        errors.push(`ESI transaction ${row.transactionId} 缺少关键字段，未导入。`);
        continue;
      }
      try {
        const payload = {
          transactionId: row.transactionId,
          date: new Date(row.date).toISOString(),
          typeId: row.typeId,
          quantity: row.quantity,
          unitPrice: row.unitPrice,
          isBuy: row.isBuy,
          locationId: row.locationId,
        };
        const sourceRef = `esi-wallet:${row.transactionId}`;
        const sourceHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
        const record = P93LedgerService.upsert(db, characterId, {
          ledgerKey: sourceRef,
          tradeKind: row.isBuy ? 'BUY' : 'SELL',
          direction: row.isBuy ? 'BUY' : 'SELL',
          typeId: row.typeId,
          locationId: row.locationId,
          quantity: row.quantity,
          unitPrice: row.unitPrice,
          tradeTime: payload.date,
          sourceType: 'ESI_WALLET_TRANSACTION',
          sourceRef,
          executionStatus: 'FULL_FILL',
          notes: 'ESI 钱包成交记录；wallet transactions 不含完整经纪人费/税费，费用完整性保持 UNKNOWN。',
          feeStatus: 'UNKNOWN',
        }, 'ESI_SYNC', 'esi-wallet-sync');
        const evidence = P93LedgerService.addEvidence(db, characterId, {
          evidenceType: 'ESI_WALLET_LOG',
          sourceSystem: 'ESI_WALLET_TRANSACTIONS',
          sourceRef,
          capturedAt: payload.date,
          payloadHash: sourceHash,
          summary: `ESI wallet transaction ${row.transactionId}`,
          metadata: {
            transactionId: row.transactionId,
            typeId: row.typeId,
            quantity: row.quantity,
            unitPrice: row.unitPrice,
            isBuy: row.isBuy,
            locationId: row.locationId,
            tradeTime: payload.date,
          },
          initialStatus: 'VERIFIED',
        }, 'ESI_SYNC');
        P93LedgerService.linkEvidence(db, characterId, record.recordId, evidence.evidenceId, 'PRIMARY', 'HIGH', undefined, 'ESI_SYNC', 'esi-wallet-sync');
        // ESI evidence establishes that a wallet transaction exists, but it
        // does not by itself make the REAL trade record verified. A human must
        // review the matching facts and invoke the record verification step.
        imported += 1;
        newLastId = Math.max(newLastId, row.transactionId);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    db.prepare(`
      INSERT INTO real_esi_transaction_sync (character_id, last_transaction_id, last_synced_at, status, error)
      VALUES (?, ?, datetime('now'), ?, ?)
      ON CONFLICT(character_id) DO UPDATE SET
        last_transaction_id = MAX(COALESCE(real_esi_transaction_sync.last_transaction_id, 0), excluded.last_transaction_id),
        last_synced_at = excluded.last_synced_at,
        status = excluded.status,
        error = excluded.error
    `).run(characterId, newLastId || null, errors.length > 0 ? 'error' : 'ok', errors.join('; ') || null);
    return { imported, skipped, verified, lastTransactionId: newLastId || null, errors };
  }
}