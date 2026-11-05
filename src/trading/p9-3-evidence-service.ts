import { createHash, randomUUID } from 'node:crypto';
import type { Db } from '../db/sqlite.js';
import type { UserContext } from '../auth/user-resolver.js';
import { getEveCapabilities, type Capabilities } from '../eve/capabilities.js';
import { callEsiOperation } from '../eve/esi-client.js';
import { P93LedgerService } from './p9-3-ledger-service.js';
import {
  realLedgerLineageFromContext,
  realLedgerLineagePredicate,
  resolveRealLedgerLineage,
  type RealLedgerLineage,
} from './p9-3-lineage.js';

const WALLET_SCOPE = 'esi-wallet.read_character_wallet.v1';
const WALLET_TRANSACTION_MAX_PAGES = 10;
const WALLET_TRANSACTION_PAGE_SIZE = 2500;
const WALLET_SYNC_LEASE_TTL_SECONDS = 30;
const WALLET_SYNC_LEASE_WAIT_MS = 5000;

class WalletIdentityChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletIdentityChangedError';
  }
}

class WalletLeaseLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletLeaseLostError';
  }
}

class WalletLeaseUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletLeaseUnavailableError';
  }
}

type WalletValidationFailure = {
  failureKey: string;
  transactionId: number | null;
  errorCode: 'TRANSACTION_DATA_INVALID';
  message: string;
};

export type NormalizedEsiWalletTransaction = {
  transactionId: number;
  date: string;
  typeId: number;
  quantity: number;
  unitPrice: number;
  isBuy: boolean;
  locationId: number;
};

export type WalletTransactionSyncErrorCode =
  | 'IDENTITY_UNAVAILABLE'
  | 'IDENTITY_CHANGED'
  | 'WALLET_SCOPE_MISSING'
  | 'ESI_REQUEST_FAILED'
  | 'TRANSACTION_DATA_INVALID'
  | 'TRANSACTION_IMPORT_FAILED';

export type WalletTransactionSyncResult = {
  ok: boolean;
  status: 'ok' | 'error';
  imported: number;
  skipped: number;
  verified: number;
  lastTransactionId: number | null;
  errors: string[];
  errorCode?: WalletTransactionSyncErrorCode;
};

export class EsiWalletTransactionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EsiWalletTransactionValidationError';
  }
}

function positiveSafeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new EsiWalletTransactionValidationError(`${field} 必须是正安全整数。`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new EsiWalletTransactionValidationError(`${field} 必须是正整数。`);
  }
  return value;
}

function finiteNonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new EsiWalletTransactionValidationError(`${field} 必须是有限非负数。`);
  }
  return value;
}

function parseEsiDate(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new EsiWalletTransactionValidationError('date 必须是可解析的非空日期字符串。');
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new EsiWalletTransactionValidationError('date 必须是可解析日期。');
  }
  return new Date(parsed).toISOString();
}

/**
 * Strict ESI wallet transaction boundary. ESI values are never coerced from
 * strings and an unknown direction is never defaulted to BUY.
 */
export function normalizeEsiWalletTransaction(row: Record<string, unknown>): NormalizedEsiWalletTransaction {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new EsiWalletTransactionValidationError('钱包交易记录必须是对象。');
  }
  if (typeof row.is_buy !== 'boolean') {
    throw new EsiWalletTransactionValidationError('is_buy 必须是 boolean。');
  }
  return {
    transactionId: positiveSafeInteger(row.transaction_id, 'transaction_id'),
    date: parseEsiDate(row.date),
    typeId: positiveInteger(row.type_id, 'type_id'),
    quantity: positiveInteger(row.quantity, 'quantity'),
    unitPrice: finiteNonNegativeNumber(row.unit_price, 'unit_price'),
    isBuy: row.is_buy,
    locationId: positiveSafeInteger(row.location_id, 'location_id'),
  };
}

function linkedCharacterMatches(db: Db, ctx: UserContext, characterId: number): boolean {
  const account = db.prepare(
    'SELECT user_id FROM eve_accounts WHERE character_id = ?',
  ).get(characterId) as { user_id: number | null } | undefined;
  if (!account) return false;

  if (ctx.userId > 0) {
    if (account.user_id !== null && account.user_id !== ctx.userId) return false;
    const userLink = db.prepare(
      'SELECT 1 FROM eve_character_links WHERE user_id = ? AND character_id = ?',
    ).get(ctx.userId, characterId);
    if (!userLink) return false;
  }
  if (ctx.chatId !== undefined) {
    const session = db.prepare('SELECT 1 FROM telegram_sessions WHERE chat_id = ?').get(ctx.chatId);
    if (!session) return false;
    const chatLink = db.prepare(
      'SELECT 1 FROM eve_character_links WHERE chat_id = ? AND character_id = ?',
    ).get(ctx.chatId, characterId);
    if (!chatLink) return false;
  }
  return ctx.userId > 0 || ctx.chatId !== undefined;
}

function walletPredicate(lineage: RealLedgerLineage | null): { sql: string; params: unknown[] } {
  if (lineage) return realLedgerLineagePredicate(null, lineage);
  return {
    sql: 'owner_user_id IS NULL AND owner_chat_id IS NULL AND binding_epoch = 0',
    params: [],
  };
}

function walletLineageValues(
  lineage: RealLedgerLineage | null,
): [number | null, number | null, number, string] {
  return lineage
    ? [lineage.ownerUserId, lineage.ownerChatId, lineage.bindingEpoch, lineage.bindingDigest]
    : [null, null, 0, ''];
}

function revalidateWalletLineage(
  db: Db,
  pinnedCtx: UserContext,
  characterId: number,
  lineage: RealLedgerLineage | null,
): void {
  if (!lineage) return;
  const current = realLedgerLineageFromContext(db, characterId, pinnedCtx);
  if (
    current.ownerUserId !== lineage.ownerUserId
    || current.ownerChatId !== lineage.ownerChatId
    || current.bindingEpoch !== lineage.bindingEpoch
  ) {
    throw new WalletIdentityChangedError('钱包同步所有权或绑定上下文已变化，已中止提交。');
  }
}

function currentLastTransactionId(
  db: Db,
  characterId: number,
  lineage: RealLedgerLineage | null,
): number | null {
  const owner = walletPredicate(lineage);
  const state = db.prepare(
    `SELECT last_transaction_id FROM real_esi_transaction_sync
     WHERE character_id = ? AND ${owner.sql}`,
  ).get(characterId, ...owner.params) as { last_transaction_id: number | null } | undefined;
  const value = Number(state?.last_transaction_id ?? 0);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function ownsWalletLease(
  db: Db,
  characterId: number,
  ownerId: string,
  lineage: RealLedgerLineage | null,
): boolean {
  const owner = walletPredicate(lineage);
  return !!db.prepare(`
    SELECT 1 FROM real_esi_transaction_sync_leases
    WHERE character_id = ? AND owner_id = ? AND ${owner.sql}
      AND expires_at > datetime('now')
  `).get(characterId, ownerId, ...owner.params);
}

async function acquireWalletLease(
  db: Db,
  characterId: number,
  lineage: RealLedgerLineage | null,
): Promise<string> {
  const ownerId = randomUUID();
  const owner = walletPredicate(lineage);
  const [ownerUserId, ownerChatId, bindingEpoch, bindingDigest] = walletLineageValues(lineage);
  const deadline = Date.now() + WALLET_SYNC_LEASE_WAIT_MS;
  do {
    const result = db.prepare(`
      INSERT INTO real_esi_transaction_sync_leases
        (character_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest,
         owner_id, acquired_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now', ?))
      ON CONFLICT(character_id, owner_user_id, owner_chat_id, binding_epoch) DO UPDATE SET
        binding_digest = excluded.binding_digest,
        owner_id = excluded.owner_id,
        acquired_at = excluded.acquired_at,
        expires_at = excluded.expires_at
      WHERE real_esi_transaction_sync_leases.expires_at <= datetime('now')
    `).run(
      characterId, ownerUserId, ownerChatId, bindingEpoch, bindingDigest,
      ownerId, `+${WALLET_SYNC_LEASE_TTL_SECONDS} seconds`,
    );
    if (result.changes === 1) return ownerId;

    const current = db.prepare(`
      SELECT owner_id FROM real_esi_transaction_sync_leases
      WHERE character_id = ? AND ${owner.sql} AND expires_at > datetime('now')
    `).get(characterId, ...owner.params) as { owner_id: string } | undefined;
    if (current?.owner_id === ownerId) return ownerId;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);

  throw new WalletLeaseUnavailableError('同一角色的钱包同步持久化租约正被占用，请稍后重试。');
}

function releaseWalletLease(
  db: Db,
  characterId: number,
  ownerId: string,
  lineage: RealLedgerLineage | null,
): void {
  const owner = walletPredicate(lineage);
  db.prepare(`
    DELETE FROM real_esi_transaction_sync_leases
    WHERE character_id = ? AND owner_id = ? AND ${owner.sql}
  `).run(characterId, ownerId, ...owner.params);
}

function assertWalletIdentityAndLease(
  db: Db,
  pinnedCtx: UserContext,
  characterId: number,
  ownerId: string,
  lineage: RealLedgerLineage | null,
): void {
  if (!linkedCharacterMatches(db, pinnedCtx, characterId)) {
    throw new WalletIdentityChangedError('目标角色关联或所有权发生变化，已中止钱包同步。');
  }
  revalidateWalletLineage(db, pinnedCtx, characterId, lineage);
  if (!ownsWalletLease(db, characterId, ownerId, lineage)) {
    throw new WalletLeaseLostError('钱包同步租约已过期或被其他任务接管，旧任务禁止继续提交。');
  }
}

function walletFailureKey(row: unknown, index: number, message: string): {
  failureKey: string;
  transactionId: number | null;
} {
  const record = row && typeof row === 'object' && !Array.isArray(row)
    ? row as Record<string, unknown>
    : null;
  const candidate = record?.transaction_id;
  const transactionId = typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0
    ? candidate
    : null;
  if (transactionId !== null) {
    return { failureKey: `transaction:${transactionId}`, transactionId };
  }
  let serialized = '';
  try {
    serialized = JSON.stringify(row);
  } catch {
    serialized = String(row);
  }
  const digest = createHash('sha256')
    .update(`${index}:${message}:${serialized}`)
    .digest('hex')
    .slice(0, 24);
  return { failureKey: `malformed:${digest}`, transactionId: null };
}

function insertWalletFailure(
  db: Db,
  characterId: number,
  lineage: RealLedgerLineage | null,
  failure: WalletValidationFailure | {
    failureKey: string;
    transactionId: number | null;
    errorCode: 'TRANSACTION_IMPORT_FAILED';
    message: string;
  },
): void {
  const [ownerUserId, ownerChatId, bindingEpoch, bindingDigest] = walletLineageValues(lineage);
  db.prepare(`
    INSERT INTO real_esi_transaction_failures
      (character_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest,
       failure_key, transaction_id, error_code, error,
       first_failed_at, last_failed_at, retry_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 0)
    ON CONFLICT(character_id, owner_user_id, owner_chat_id, binding_epoch, failure_key) DO UPDATE SET
      binding_digest = excluded.binding_digest,
      transaction_id = excluded.transaction_id,
      error_code = excluded.error_code,
      error = excluded.error,
      last_failed_at = excluded.last_failed_at,
      retry_count = real_esi_transaction_failures.retry_count + 1
  `).run(
    characterId,
    ownerUserId,
    ownerChatId,
    bindingEpoch,
    bindingDigest,
    failure.failureKey,
    failure.transactionId,
    failure.errorCode,
    failure.message.slice(0, 2000),
  );
}

function recordWalletFailure(
  db: Db,
  pinnedCtx: UserContext,
  characterId: number,
  ownerId: string,
  lineage: RealLedgerLineage | null,
  failure: WalletValidationFailure | {
    failureKey: string;
    transactionId: number | null;
    errorCode: 'TRANSACTION_IMPORT_FAILED';
    message: string;
  },
): void {
  db.transaction(() => {
    assertWalletIdentityAndLease(db, pinnedCtx, characterId, ownerId, lineage);
    insertWalletFailure(db, characterId, lineage, failure);
    assertWalletIdentityAndLease(db, pinnedCtx, characterId, ownerId, lineage);
  }).immediate();
}

async function failWalletSync(
  db: Db,
  characterId: number,
  lineage: RealLedgerLineage | null,
  errorCode: WalletTransactionSyncErrorCode,
  errors: string[],
): Promise<WalletTransactionSyncResult> {
  const message = errors.join('; ');
  let ownerId: string;
  try {
    ownerId = await acquireWalletLease(db, characterId, lineage);
  } catch {
    return {
      ok: false,
      status: 'error',
      imported: 0,
      skipped: 0,
      verified: 0,
      lastTransactionId: currentLastTransactionId(db, characterId, lineage),
      errors,
      errorCode,
    };
  }

  try {
    db.transaction(() => {
      if (!ownsWalletLease(db, characterId, ownerId, lineage)) {
        throw new WalletLeaseLostError('钱包同步租约已失效。');
      }
      const owner = walletPredicate(lineage);
      const [ownerUserId, ownerChatId, bindingEpoch, bindingDigest] = walletLineageValues(lineage);
      db.prepare(`
        INSERT INTO real_esi_transaction_sync
          (character_id, owner_user_id, owner_chat_id, binding_epoch, binding_digest,
           status, error, last_synced_at)
        VALUES (?, ?, ?, ?, ?, 'error', ?, datetime('now'))
        ON CONFLICT(character_id, owner_user_id, owner_chat_id, binding_epoch) DO UPDATE SET
          binding_digest = excluded.binding_digest,
          status = 'error',
          error = excluded.error,
          last_synced_at = excluded.last_synced_at
      `).run(
        characterId, ownerUserId, ownerChatId, bindingEpoch, bindingDigest,
        message.slice(0, 2000) || null,
      );
      if (!ownsWalletLease(db, characterId, ownerId, lineage)) {
        throw new WalletLeaseLostError('钱包同步租约已失效。');
      }
      const current = db.prepare(`
        SELECT status FROM real_esi_transaction_sync
        WHERE character_id = ? AND ${owner.sql}
      `).get(characterId, ...owner.params) as { status: string } | undefined;
      if (current?.status !== 'error') throw new WalletIdentityChangedError('钱包同步失败状态未安全持久化。');
    }).immediate();
  } finally {
    releaseWalletLease(db, characterId, ownerId, lineage);
  }

  return {
    ok: false,
    status: 'error',
    imported: 0,
    skipped: 0,
    verified: 0,
    lastTransactionId: currentLastTransactionId(db, characterId, lineage),
    errors,
    errorCode,
  };
}

async function persistWalletSyncBatch(
  db: Db,
  characterId: number,
  pinnedCtx: UserContext,
  lineage: RealLedgerLineage | null,
  ordered: NormalizedEsiWalletTransaction[],
  validationFailures: WalletValidationFailure[],
): Promise<WalletTransactionSyncResult> {
  let ownerId: string;
  try {
    ownerId = await acquireWalletLease(db, characterId, lineage);
  } catch (error) {
    return {
      ok: false,
      status: 'error',
      imported: 0,
      skipped: 0,
      verified: 0,
      lastTransactionId: currentLastTransactionId(db, characterId, lineage),
      errors: [error instanceof Error ? error.message : String(error)],
      errorCode: 'TRANSACTION_IMPORT_FAILED',
    };
  }

  try {
    const startState = db.transaction(() => {
      assertWalletIdentityAndLease(db, pinnedCtx, characterId, ownerId, lineage);
      const owner = walletPredicate(lineage);
      // Every sync revalidates the full retry window. Malformed rows have no
      // durable transaction ID, so stale malformed markers are replaced by the
      // current response after the complete batch has passed pagination checks.
      db.prepare(`
        DELETE FROM real_esi_transaction_failures
        WHERE character_id = ? AND transaction_id IS NULL AND ${owner.sql}
      `).run(characterId, ...owner.params);
      for (const failure of validationFailures) {
        insertWalletFailure(db, characterId, lineage, failure);
      }
      assertWalletIdentityAndLease(db, pinnedCtx, characterId, ownerId, lineage);
      const pendingFailureIds = new Set(
        (db.prepare(`
          SELECT DISTINCT transaction_id
          FROM real_esi_transaction_failures
          WHERE character_id = ? AND transaction_id IS NOT NULL AND ${owner.sql}
        `).all(characterId, ...owner.params) as Array<{ transaction_id: number }>)
          .map((row) => row.transaction_id),
      );
      return { startCursor: currentLastTransactionId(db, characterId, lineage), pendingFailureIds };
    }).immediate();
    const { startCursor, pendingFailureIds } = startState;

    let imported = 0;
    let skipped = 0;
    const verified = 0;
    let importFailure = false;
    const errors = validationFailures.map((failure) => failure.message);
    const currentValidationFailureKeys = new Set(validationFailures.map((failure) => failure.failureKey));

    for (const row of ordered) {
      // The cursor is an optimisation, not permission to ignore a durable
      // failure. A corrected row at or below the current cursor must still be
      // replayed so its existing marker can be cleared idempotently.
      if (row.transactionId <= (startCursor ?? 0) && !pendingFailureIds.has(row.transactionId)) {
        skipped += 1;
        continue;
      }
      try {
        db.transaction(() => {
          assertWalletIdentityAndLease(db, pinnedCtx, characterId, ownerId, lineage);
          const payload = {
            transactionId: row.transactionId,
            date: row.date,
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
            tradeTime: row.date,
            sourceType: 'ESI_WALLET_TRANSACTION',
            sourceRef,
            executionStatus: 'FULL_FILL',
            notes: 'ESI 钱包成交记录；wallet transactions 不含完整经纪人费/税费，费用完整性保持 UNKNOWN。',
            feeStatus: 'UNKNOWN',
          }, 'ESI_SYNC', 'esi-wallet-sync', lineage);
          const evidence = P93LedgerService.addEvidence(db, characterId, {
            evidenceType: 'ESI_WALLET_LOG',
            sourceSystem: 'ESI_WALLET_TRANSACTIONS',
            sourceRef,
            capturedAt: row.date,
            payloadHash: sourceHash,
            summary: `ESI wallet transaction ${row.transactionId}`,
            metadata: {
              transactionId: row.transactionId,
              typeId: row.typeId,
              quantity: row.quantity,
              unitPrice: row.unitPrice,
              isBuy: row.isBuy,
              locationId: row.locationId,
              tradeTime: row.date,
            },
            initialStatus: 'VERIFIED',
          }, 'ESI_SYNC', lineage);
          if (['VERIFIED', 'REVERSED', 'CORRECTED'].includes(record.recordState)) {
            const existingLink = db.prepare(`
              SELECT 1 FROM real_trade_evidence_links
              WHERE record_id = ? AND evidence_id = ?
                AND relation IN ('PRIMARY', 'CORROBORATING')
              LIMIT 1
            `).get(record.recordId, evidence.evidenceId);
            if (!existingLink) throw new Error('已核实交易缺少原始 ESI 证据关联，拒绝改写已核实事实。');
          } else {
            P93LedgerService.linkEvidence(
              db,
              characterId,
              record.recordId,
              evidence.evidenceId,
              'PRIMARY',
              'HIGH',
              undefined,
              'ESI_SYNC',
              'esi-wallet-sync',
              lineage,
            );
          }
          if (currentValidationFailureKeys.has(`transaction:${row.transactionId}`)) {
            // A malformed duplicate sharing this transaction ID is still present
            // in the current response. Process the valid row idempotently, but
            // keep the current validation marker so the batch cannot look clean.
            db.prepare(`
              DELETE FROM real_esi_transaction_failures
              WHERE character_id = ? AND transaction_id = ?
                AND ${walletPredicate(lineage).sql}
                AND error_code = 'TRANSACTION_IMPORT_FAILED'
            `).run(characterId, row.transactionId, ...walletPredicate(lineage).params);
          } else {
            db.prepare(`
              DELETE FROM real_esi_transaction_failures
              WHERE character_id = ?
                AND (transaction_id = ? OR failure_key = ?)
                AND ${walletPredicate(lineage).sql}
            `).run(
              characterId, row.transactionId, `transaction:${row.transactionId}`,
              ...walletPredicate(lineage).params,
            );
          }
          assertWalletIdentityAndLease(db, pinnedCtx, characterId, ownerId, lineage);
        }).immediate();
        imported += 1;
      } catch (error) {
        if (error instanceof WalletIdentityChangedError || error instanceof WalletLeaseLostError) {
          throw error;
        }
        importFailure = true;
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`ESI 钱包交易 ${row.transactionId} 导入失败：${message}`);
        recordWalletFailure(db, pinnedCtx, characterId, ownerId, lineage, {
          failureKey: `transaction:${row.transactionId}`,
          transactionId: row.transactionId,
          errorCode: 'TRANSACTION_IMPORT_FAILED',
          message,
        });
      }
    }

    const candidateIds = [
      ...ordered.map((row) => row.transactionId),
      ...validationFailures
        .map((failure) => failure.transactionId)
        .filter((value): value is number => typeof value === 'number' && value > 0),
    ];
    const candidateBoundary = candidateIds.reduce(
      (maximum, transactionId) => Math.max(maximum, transactionId),
      startCursor ?? 0,
    );

    const cursorState = db.transaction(() => {
      assertWalletIdentityAndLease(db, pinnedCtx, characterId, ownerId, lineage);
      const owner = walletPredicate(lineage);
      const observedCursor = currentLastTransactionId(db, characterId, lineage);
      const blockingFailures = db.prepare(`
        SELECT failure_key, transaction_id, error_code, error
        FROM real_esi_transaction_failures
        WHERE character_id = ? AND ${owner.sql}
          AND (transaction_id IS NULL OR transaction_id <= ?)
        ORDER BY transaction_id IS NOT NULL, transaction_id, failure_key
      `).all(characterId, ...owner.params, candidateBoundary) as Array<{
        failure_key: string;
        transaction_id: number | null;
        error_code: 'TRANSACTION_DATA_INVALID' | 'TRANSACTION_IMPORT_FAILED';
        error: string;
      }>;

      const canAdvance = errors.length === 0 && blockingFailures.length === 0;
      const persistedBoundary = canAdvance
        ? (candidateBoundary > 0 ? Math.max(observedCursor ?? 0, candidateBoundary) : observedCursor)
        : observedCursor;
      const status: 'ok' | 'error' = canAdvance ? 'ok' : 'error';
      const blockingMessages = blockingFailures.map((failure) => (
        failure.transaction_id === null
          ? `未解决的钱包交易数据错误：${failure.error}`
          : `未解决的钱包交易 ${failure.transaction_id}：${failure.error}`
      ));
      const errorText = [...errors, ...(errors.length === 0 ? blockingMessages : [])]
        .join('; ')
        .slice(0, 2000) || null;

      // The cursor is monotonic in SQL as well as in JavaScript. A late task
      // carrying an older maximum can therefore never move the durable cursor
      // backwards, even if future callers bypass this service logic.
      const [ownerUserId, ownerChatId, bindingEpoch] = walletLineageValues(lineage);
      db.prepare(`
        INSERT INTO real_esi_transaction_sync
          (character_id, owner_user_id, owner_chat_id, binding_epoch,
           last_transaction_id, last_synced_at, status, error)
        VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?)
        ON CONFLICT(character_id, owner_user_id, owner_chat_id, binding_epoch) DO UPDATE SET
          last_transaction_id = CASE
            WHEN excluded.last_transaction_id IS NULL
              THEN real_esi_transaction_sync.last_transaction_id
            WHEN real_esi_transaction_sync.last_transaction_id IS NULL
              THEN excluded.last_transaction_id
            WHEN excluded.last_transaction_id > real_esi_transaction_sync.last_transaction_id
              THEN excluded.last_transaction_id
            ELSE real_esi_transaction_sync.last_transaction_id
          END,
          last_synced_at = excluded.last_synced_at,
          status = excluded.status,
          error = excluded.error
      `).run(
        characterId, ownerUserId, ownerChatId, bindingEpoch,
        persistedBoundary ?? null, status, errorText,
      );

      // This post-write check is intentionally inside the same transaction.
      // A trigger or concurrent unlink during the cursor write rolls the cursor
      // back instead of leaving an orphaned success boundary.
      assertWalletIdentityAndLease(db, pinnedCtx, characterId, ownerId, lineage);
      return {
        observedCursor,
        persistedBoundary: currentLastTransactionId(db, characterId, lineage),
        status,
        canAdvance,
        blockingMessages,
        blockingErrorCodes: blockingFailures.map((failure) => failure.error_code),
      };
    }).immediate();

    const resultLastId = cursorState.status === 'ok'
      ? ((candidateBoundary > 0 ? candidateBoundary : cursorState.observedCursor) ?? null)
      : cursorState.persistedBoundary;
    const resultErrors = errors.length > 0 ? errors : cursorState.blockingMessages;
    const blockingImportFailure = cursorState.blockingErrorCodes.includes('TRANSACTION_IMPORT_FAILED');
    const errorCode: WalletTransactionSyncErrorCode | undefined = resultErrors.length === 0
      ? undefined
      : importFailure || blockingImportFailure
        ? 'TRANSACTION_IMPORT_FAILED'
        : 'TRANSACTION_DATA_INVALID';

    return {
      ok: cursorState.status === 'ok',
      status: cursorState.status,
      imported,
      skipped,
      verified,
      lastTransactionId: resultLastId,
      errors: resultErrors,
      ...(errorCode ? { errorCode } : {}),
    };
  } finally {
    releaseWalletLease(db, characterId, ownerId, lineage);
  }
}

export class P93EsiEvidenceService {
  static async syncWalletTransactions(
    db: Db,
    characterId: number,
    ctx: UserContext,
    lineageInput?: RealLedgerLineage | null,
  ): Promise<WalletTransactionSyncResult> {
    if (!Number.isSafeInteger(characterId) || characterId <= 0) {
      return {
        ok: false,
        status: 'error',
        imported: 0,
        skipped: 0,
        verified: 0,
        lastTransactionId: null,
        errors: ['目标角色 ID 无效。'],
        errorCode: 'IDENTITY_UNAVAILABLE',
      };
    }

    // Pin the whole operation to the route-selected character. getLinkedCharacter
    // re-checks ownership each time and never falls back to another character.
    const pinnedCtx: UserContext = { ...ctx, characterId };
    let lineage: RealLedgerLineage | null;
    try {
      lineage = resolveRealLedgerLineage(db, characterId, lineageInput);
    } catch (error) {
      return {
        ok: false,
        status: 'error',
        imported: 0,
        skipped: 0,
        verified: 0,
        lastTransactionId: null,
        errors: [error instanceof Error ? error.message : String(error)],
        errorCode: 'IDENTITY_UNAVAILABLE',
      };
    }
    if (!linkedCharacterMatches(db, pinnedCtx, characterId)) {
      return await failWalletSync(db, characterId, lineage, 'IDENTITY_UNAVAILABLE', [
        '目标角色未关联、已解绑或不属于当前用户，已中止钱包同步。',
      ]);
    }

    // Always establish a new capability snapshot from current stored scopes.
    // callEsiOperation only accepts a fresh snapshot; waiting for some other
    // feature to create one is not allowed.
    let capabilities: Capabilities;
    try {
      capabilities = await getEveCapabilities(db, 'P9.3 wallet transaction sync', pinnedCtx);
    } catch (error) {
      return await failWalletSync(db, characterId, lineage, 'IDENTITY_UNAVAILABLE', [
        `无法建立 ESI 能力快照：${error instanceof Error ? error.message : String(error)}`,
      ]);
    }
    if (!capabilities.authenticated || capabilities.characterId !== characterId) {
      return await failWalletSync(db, characterId, lineage, 'IDENTITY_UNAVAILABLE', [
        '能力快照未能绑定到目标角色，已中止钱包同步。',
      ]);
    }
    if (!capabilities.grantedScopes.includes(WALLET_SCOPE)) {
      return await failWalletSync(db, characterId, lineage, 'WALLET_SCOPE_MISSING', [
        `缺少 ${WALLET_SCOPE} 权限，请在 EVE SSO 中重新授权角色钱包只读权限后重试。`,
      ]);
    }

    const storedLastId = Number(
      currentLastTransactionId(db, characterId, lineage) ?? 0,
    );
    const lastId = Number.isSafeInteger(storedLastId) && storedLastId > 0 ? storedLastId : 0;

    // current ESI metadata paginates wallet history with `from_id`, not the
    // generic `page` parameter. Fetch and validate every page before writing so
    // an incomplete page walk can never produce a partial committed batch.
    const rawRows: unknown[] = [];
    const seenBoundaries = new Set<number>();
    let fromId: number | null = null;
    let declaredTotalPages: number | null = null;
    for (let page = 1; page <= WALLET_TRANSACTION_MAX_PAGES; page += 1) {
      if (!linkedCharacterMatches(db, pinnedCtx, characterId)) {
        return await failWalletSync(db, characterId, lineage, 'IDENTITY_CHANGED', [
          '同步期间目标角色关联或所有权发生变化，已中止且未写入账本。',
        ]);
      }
      const args: Record<string, unknown> = { character_id: characterId };
      if (fromId !== null) args.from_id = fromId;
      const result = await callEsiOperation<unknown[]>(
        db,
        'get_characters_character_id_wallet_transactions',
        args,
        pinnedCtx,
        {
          maxPages: WALLET_TRANSACTION_MAX_PAGES,
          bypassCache: true,
          identityCurrent: () => linkedCharacterMatches(db, pinnedCtx, characterId),
        },
      );
      if (!result.ok) {
        return await failWalletSync(db, characterId, lineage, 'ESI_REQUEST_FAILED', [`ESI 钱包成交同步失败：${result.error}`]);
      }

      const advertisedPagesRaw = result.headers['x-pages'];
      if (advertisedPagesRaw !== undefined) {
        const advertisedPages = Number(advertisedPagesRaw);
        if (!Number.isSafeInteger(advertisedPages) || advertisedPages < 1) {
          return await failWalletSync(db, characterId, lineage, 'ESI_REQUEST_FAILED', [
            'ESI 钱包成交接口返回了无效的 X-Pages 分页头，本批次未提交。',
          ]);
        }
        if (advertisedPages > WALLET_TRANSACTION_MAX_PAGES) {
          return await failWalletSync(db, characterId, lineage, 'ESI_REQUEST_FAILED', [
            `ESI 钱包成交同步需要 ${advertisedPages} 页，超过允许的最大页数 ${WALLET_TRANSACTION_MAX_PAGES}，本批次未提交。`,
          ]);
        }
        if (declaredTotalPages !== null && advertisedPages !== declaredTotalPages) {
          return await failWalletSync(db, characterId, lineage, 'ESI_REQUEST_FAILED', [
            'ESI 钱包成交接口在分页过程中返回了不一致的 X-Pages，本批次未提交。',
          ]);
        }
        declaredTotalPages = advertisedPages;
      }
      if (!Array.isArray(result.data)) {
        return await failWalletSync(db, characterId, lineage, 'TRANSACTION_DATA_INVALID', [
          'ESI 钱包成交接口未返回数组，本批次未提交任何账本或游标变更。',
        ]);
      }
      rawRows.push(...result.data);

      if (result.data.length === 0) {
        if (declaredTotalPages !== null && declaredTotalPages > 1) {
          return await failWalletSync(db, characterId, lineage, 'ESI_REQUEST_FAILED', [
            `ESI 钱包成交接口声明 ${declaredTotalPages} 页，但第 ${page} 页为空，本批次未提交。`,
          ]);
        }
        break;
      }
      if (declaredTotalPages !== null && page >= declaredTotalPages) break;
      if (declaredTotalPages === null && result.data.length < WALLET_TRANSACTION_PAGE_SIZE) break;

      const validPageIds = result.data
        .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && !Array.isArray(row))
        .map((row) => row.transaction_id)
        .filter((value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
      if (validPageIds.length !== result.data.length) {
        return await failWalletSync(db, characterId, lineage, 'TRANSACTION_DATA_INVALID', [
          'ESI 钱包成交分页记录缺少有效 transaction_id，无法安全建立同步边界，本批次未提交。',
        ]);
      }
      const nextFromId = Math.min(...validPageIds);
      if (seenBoundaries.has(nextFromId) || (fromId !== null && nextFromId >= fromId)) {
        return await failWalletSync(db, characterId, lineage, 'ESI_REQUEST_FAILED', [
          'ESI 钱包成交分页未向前推进，本批次未提交。',
        ]);
      }
      if (lastId > 0 && nextFromId <= lastId) break;
      if (page === WALLET_TRANSACTION_MAX_PAGES) {
        return await failWalletSync(db, characterId, lineage, 'ESI_REQUEST_FAILED', [
          `ESI 钱包成交同步超过允许的最大页数 ${WALLET_TRANSACTION_MAX_PAGES}，本批次未提交。`,
        ]);
      }
      seenBoundaries.add(nextFromId);
      fromId = nextFromId;
    }

    // A character switch may happen while any network request is in flight.
    // No ledger write or cursor movement is permitted after that point.
    if (!linkedCharacterMatches(db, pinnedCtx, characterId)) {
      return await failWalletSync(db, characterId, lineage, 'IDENTITY_CHANGED', [
        '同步期间目标角色关联或所有权发生变化，已中止且未写入账本。',
      ]);
    }

    const validationFailures: WalletValidationFailure[] = [];
    const ordered: NormalizedEsiWalletTransaction[] = [];
    const seenTransactionIds = new Set<number>();
    for (let index = 0; index < rawRows.length; index += 1) {
      const raw = rawRows[index];
      try {
        const normalized = normalizeEsiWalletTransaction(raw as Record<string, unknown>);
        if (seenTransactionIds.has(normalized.transactionId)) {
          throw new EsiWalletTransactionValidationError(
            `transaction_id ${normalized.transactionId} 在同一批次中重复。`,
          );
        }
        seenTransactionIds.add(normalized.transactionId);
        ordered.push(normalized);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const message = `ESI 钱包交易第 ${index + 1} 条校验失败：${detail}`;
        validationFailures.push({
          ...walletFailureKey(raw, index, message),
          errorCode: 'TRANSACTION_DATA_INVALID',
          message,
        });
      }
    }
    ordered.sort((a, b) => a.transactionId - b.transactionId);

    try {
      return await persistWalletSyncBatch(
        db,
        characterId,
        pinnedCtx,
        lineage,
        ordered,
        validationFailures,
      );
    } catch (error) {
      if (error instanceof WalletIdentityChangedError) {
        return await failWalletSync(db, characterId, lineage, 'IDENTITY_CHANGED', [error.message]);
      }
      if (error instanceof WalletLeaseLostError || error instanceof WalletLeaseUnavailableError) {
        return {
          ok: false,
          status: 'error',
          imported: 0,
          skipped: 0,
          verified: 0,
          lastTransactionId: currentLastTransactionId(db, characterId, lineage),
          errors: [error.message],
          errorCode: 'TRANSACTION_IMPORT_FAILED',
        };
      }
      throw error;
    }
  }
}
