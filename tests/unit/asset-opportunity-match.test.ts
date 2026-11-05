import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import { RealOpportunityMatchService } from '../../src/assets/opportunity-match-service.js';
import type { Db } from '../../src/db/sqlite.js';
import { testAssetLineage } from '../helpers/asset-lineage.js';

const CHARACTER_ID = 90000041;
const OTHER_CHARACTER_ID = 90000042;
const JITA = 60003760;
const AMARR = 60008494;
const JITA_REGION = 10000002;
const AMARR_REGION = 10000043;
const LINEAGE = testAssetLineage(CHARACTER_ID);
const OTHER_LINEAGE = testAssetLineage(OTHER_CHARACTER_ID);

let db: Database.Database;

function insertLocation(locationId: number, name: string, regionId: number, systemName: string): void {
  db.prepare(`
    INSERT INTO real_asset_locations
      (location_id, location_type, location_name, solar_system_id, solar_system_name,
       region_id, region_name, parent_location_id, resolution_status, resolution_source, resolved_at)
    VALUES (?, 'STATION', ?, ?, ?, ?, ?, NULL, 'RESOLVED', 'sde_stations', datetime('now'))
  `).run(locationId, name, locationId - 60003760 + 30000142, systemName, regionId,
    regionId === JITA_REGION ? 'The Forge' : 'Domain');
}

function insertAsset(itemId: number, typeId: number, quantity: number, locationId: number): void {
  db.prepare(`
    INSERT INTO character_assets
      (character_id, item_id, type_id, location_id, location_type, location_flag,
       quantity, is_singleton, is_blueprint_copy, data_json, synced_at,
       owner_user_id, owner_chat_id, binding_epoch, binding_digest)
    VALUES (?, ?, ?, ?, 'station', 'Hangar', ?, 0, 0, '{}', datetime('now'), ?, ?, ?, ?)
  `).run(
    CHARACTER_ID, itemId, typeId, locationId, quantity,
    LINEAGE.ownerUserId, LINEAGE.ownerChatId, LINEAGE.bindingEpoch, LINEAGE.bindingDigest,
  );
}

function seedSnapshot(totalItems: number, totalQuantity: number, uniqueTypes: number): void {
  db.prepare(`
    INSERT INTO real_asset_snapshots
      (snapshot_id, character_id, job_id, started_at, completed_at, status,
       total_items, total_unique_types, total_locations, total_quantity,
       data_hash, source, is_latest, owner_user_id, owner_chat_id, binding_epoch, binding_digest)
    VALUES ('SNAP-MATCH-1', ?, NULL, '2026-11-03T04:00:00.000Z',
       '2026-11-03T04:00:10.000Z', 'COMPLETED', ?, ?, 2, ?,
       'hash-match-1', 'esi_character_assets', 1, ?, ?, ?, ?)
  `).run(
    CHARACTER_ID, totalItems, uniqueTypes, totalQuantity,
    LINEAGE.ownerUserId, LINEAGE.ownerChatId, LINEAGE.bindingEpoch, LINEAGE.bindingDigest,
  );
  db.prepare(`
    INSERT INTO real_asset_snapshot_items
      (snapshot_id, item_id, type_id, quantity, location_id, location_type,
       location_flag, is_singleton, is_blueprint_copy, parent_item_id, raw_json)
    SELECT 'SNAP-MATCH-1', item_id, type_id, COALESCE(quantity, 1), location_id,
           location_type, location_flag, is_singleton, is_blueprint_copy, NULL, data_json
    FROM character_assets
    WHERE character_id = ?
      AND owner_user_id = ? AND owner_chat_id = ? AND binding_epoch = ?
    ORDER BY item_id
  `).run(
    CHARACTER_ID, LINEAGE.ownerUserId, LINEAGE.ownerChatId, LINEAGE.bindingEpoch,
  );
}

function insertOpportunity(input: {
  id: string;
  typeId: number;
  strategy?: 'station_arbitrage' | 'regional_hauling';
  buyLocationId?: number;
  buyRegionId?: number;
  required?: number;
  state?: string;
  feeNet?: number;
  characterId?: number;
}): void {
  const buyLocationId = input.buyLocationId ?? JITA;
  const buyRegionId = input.buyRegionId ?? JITA_REGION;
  const required = input.required ?? 10;
  const characterId = input.characterId ?? CHARACTER_ID;
  const lineage = characterId === CHARACTER_ID ? LINEAGE : OTHER_LINEAGE;
  db.prepare(`
    INSERT INTO p9_real_opportunities
      (opportunity_id, character_id, scan_key, strategy, type_id,
       buy_location_id, sell_location_id, buy_region_id, sell_region_id,
       buy_price, sell_price, suggested_quantity, executable_quantity,
       purchase_amount, sales_revenue, broker_fees, sales_tax,
       theoretical_gross_profit, executable_gross_profit, fee_net_profit,
       capital_required, roi_pct, buy_snapshot_id, sell_snapshot_id,
       calculation_version, original_snapshot_json, state, detected_at, expires_at,
       owner_user_id, owner_chat_id, binding_epoch, binding_digest)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 10, 12, ?, ?, 100, 120, 1, 1,
       20, 18, ?, 100, 10, 'BUY-SNAP', 'SELL-SNAP', 'test-v1', '{}', ?,
       '2026-11-03T04:00:00.000Z', '2027-01-01T00:00:00.000Z', ?, ?, ?, ?)
  `).run(
    input.id, characterId, `scan:${input.id}`,
    input.strategy ?? 'station_arbitrage', input.typeId,
    buyLocationId, AMARR, buyRegionId, AMARR_REGION,
    required, required, input.feeNet ?? 1000,
    input.state ?? 'NEW',
    lineage.ownerUserId, lineage.ownerChatId ?? 0,
    lineage.bindingEpoch, lineage.bindingDigest,
  );
}

function seedMarketOrder(typeId: number, locationId = JITA, regionId = JITA_REGION): void {
  db.prepare(`
    INSERT INTO market_orders
      (order_id, type_id, region_id, system_id, station_id, location_id,
       is_buy_order, price, volume_remain, volume_total, min_volume,
       duration, range, issued)
    VALUES (?, ?, ?, 30000142, ?, ?, 0, 12, 100, 100, 1, 90, 'station', datetime('now'))
  `).run(typeId * 10 + 1, typeId, regionId, locationId, locationId);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  insertLocation(JITA, 'Jita Trade Hub', JITA_REGION, 'Jita');
  insertLocation(AMARR, 'Amarr Trade Hub', AMARR_REGION, 'Amarr');
});

afterEach(() => {
  db.close();
});

describe('real inventory to opportunity matching (P9.2.6)', () => {
  it('classifies support, reserves stock once, and flags transport without computing profit', () => {
    // 15 units at Jita: first active opportunity reserves 10, second gets 5.
    insertAsset(1, 34, 10, JITA);
    insertAsset(2, 34, 5, JITA);
    // Type 587 exists only in Amarr: held, but not usable at the Jita BUY hub.
    insertAsset(3, 587, 7, AMARR);
    // Type 588 has no current inventory.
    // Type 590 exists at an unknown terminal: partial knowledge stays UNKNOWN.
    insertAsset(4, 590, 6, 999999999);
    db.prepare(`
      INSERT INTO real_asset_locations
        (location_id, location_type, location_name, solar_system_id, solar_system_name,
         region_id, region_name, parent_location_id, resolution_status, resolution_source, resolved_at)
      VALUES (999999999, 'UNKNOWN', NULL, NULL, NULL, NULL, NULL, NULL,
              'UNKNOWN', 'none', datetime('now'))
    `).run();
    // Type 591 is at Jita and will be used by a cross-hub opportunity.
    insertAsset(5, 591, 8, JITA);
    seedSnapshot(5, 10 + 5 + 7 + 6 + 8, 4); // four distinct held types; 588 has no stock

    for (const typeId of [34, 587, 588, 590, 591]) seedMarketOrder(typeId);

    insertOpportunity({ id: 'OPP-S1', typeId: 34, required: 10, state: 'ACTIONABLE', feeNet: 5000 });
    insertOpportunity({ id: 'OPP-S2', typeId: 34, required: 10, state: 'NEW', feeNet: 4000 });
    insertOpportunity({ id: 'OPP-OTHER-HUB', typeId: 587, required: 7, state: 'NEW' });
    insertOpportunity({ id: 'OPP-NO-STOCK', typeId: 588, required: 10, state: 'NEW' });
    insertOpportunity({ id: 'OPP-UNKNOWN', typeId: 590, required: 10, state: 'NEW' });
    insertOpportunity({
      id: 'OPP-HAUL', typeId: 591, strategy: 'regional_hauling', required: 5, state: 'WATCHING',
    });

    const result = RealOpportunityMatchService.recompute(db as Db, CHARACTER_ID, LINEAGE);
    expect(result.computed).toBe(6);
    const byId = new Map(result.matches.map((match) => [match.opportunityId, match]));

    const first = byId.get('OPP-S1')!;
    expect(first.supportClass).toBe('SUPPORTED');
    expect(first.heldQuantity).toBe(15);
    expect(first.accessibleQuantity).toBe(10);
    expect(first.needsTransport).toBe(false);
    expect(first.snapshotId).toBe('SNAP-MATCH-1');

    const second = byId.get('OPP-S2')!;
    expect(second.supportClass).toBe('PARTIAL');
    expect(second.heldQuantity).toBe(15);
    expect(second.accessibleQuantity).toBe(5);
    const reservation = second.locations.find((row) => 'reservation' in row) as any;
    expect(reservation.reservation).toMatchObject({
      rawAccessibleAtBuyHub: 15,
      remainingBeforeThisOpportunity: 5,
      reservedByEarlierOpportunities: 10,
      allocatedToThisOpportunity: 5,
      remainingAfterThisOpportunity: 0,
    });

    expect(byId.get('OPP-OTHER-HUB')!.supportClass).toBe('UNAVAILABLE');
    expect(byId.get('OPP-OTHER-HUB')!.accessibleQuantity).toBe(0);
    expect(byId.get('OPP-OTHER-HUB')!.needsTransport).toBe(true);

    expect(byId.get('OPP-NO-STOCK')!.supportClass).toBe('NEEDS_PURCHASE');
    expect(byId.get('OPP-NO-STOCK')!.heldQuantity).toBe(0);

    expect(byId.get('OPP-UNKNOWN')!.supportClass).toBe('UNKNOWN');
    expect(byId.get('OPP-UNKNOWN')!.heldQuantity).toBe(6);
    expect(byId.get('OPP-UNKNOWN')!.needsTransport).toBe(true);

    const haul = byId.get('OPP-HAUL')!;
    expect(haul.supportClass).toBe('SUPPORTED');
    expect(haul.accessibleQuantity).toBe(5);
    // Cross-hub always needs transport even when stock is already at the BUY hub.
    expect(haul.needsTransport).toBe(true);

    const dataQuality = haul.locations.find((row) => 'dataQuality' in row) as any;
    expect(dataQuality.dataQuality).toMatchObject({
      consistentCurrentSnapshot: true,
      snapshotId: 'SNAP-MATCH-1',
      unknownLocationQuantity: 0,
      marketTradable: true,
    });

    const listed = RealOpportunityMatchService.list(db as Db, CHARACTER_ID, LINEAGE, { supportClass: 'SUPPORTED' });
    expect(listed.total).toBe(2);
    expect(listed.rows.every((row) => row.support_class === 'SUPPORTED')).toBe(true);
    expect(listed.rows[0].supportClassZh).toBe('库存可支持');
    expect(listed.rows[0].needs_transport).toBeTypeOf('boolean');

    // Terminal opportunity states drop their old linkage on the next recompute.
    db.prepare("UPDATE p9_real_opportunities SET state = 'REJECTED' WHERE opportunity_id = 'OPP-S2'").run();
    const afterReject = RealOpportunityMatchService.recompute(db as Db, CHARACTER_ID, LINEAGE);
    expect(afterReject.matches.some((match) => match.opportunityId === 'OPP-S2')).toBe(false);
    expect(RealOpportunityMatchService.list(db as Db, CHARACTER_ID, LINEAGE).total).toBe(5);
  });

  it('keeps UNKNOWN when the current set does not match the latest complete snapshot', () => {
    insertAsset(1, 34, 10, JITA);
    seedSnapshot(1, 10, 1);
    seedMarketOrder(34);
    insertOpportunity({ id: 'OPP-STALE-SET', typeId: 34, required: 10 });

    // Corrupt the persisted item set: linkage must not trust the current set.
    db.prepare('UPDATE real_asset_snapshot_items SET quantity = quantity + 1 WHERE snapshot_id = ?')
      .run('SNAP-MATCH-1');

    const result = RealOpportunityMatchService.recompute(db as Db, CHARACTER_ID, LINEAGE);
    expect(result.matches[0]).toMatchObject({
      supportClass: 'UNKNOWN',
      heldQuantity: 0,
      accessibleQuantity: 0,
      snapshotId: null,
    });
    const quality = result.matches[0].locations.find((row) => 'dataQuality' in row) as any;
    expect(quality.dataQuality.consistentCurrentSnapshot).toBe(false);
  });

  it('rejects different item sets when aggregate counts, quantities, and type counts match', () => {
    insertAsset(1, 34, 1, JITA);
    insertAsset(2, 35, 9, JITA);
    seedSnapshot(2, 10, 2);

    // Replace A+B with C+D. The aggregate header values remain identical, but
    // neither the item identities nor the held type IDs are the same.
    db.prepare('DELETE FROM character_assets WHERE character_id = ?').run(CHARACTER_ID);
    insertAsset(3, 36, 1, JITA);
    insertAsset(4, 37, 9, JITA);
    seedMarketOrder(36);
    insertOpportunity({ id: 'OPP-ITEM-SET', typeId: 36, required: 1 });

    const result = RealOpportunityMatchService.recompute(db as Db, CHARACTER_ID, LINEAGE);
    expect(result.matches[0]).toMatchObject({
      supportClass: 'UNKNOWN',
      heldQuantity: 0,
      accessibleQuantity: 0,
      snapshotId: null,
    });
    const quality = result.matches[0].locations.find((row) => 'dataQuality' in row) as any;
    expect(quality.dataQuality.consistentCurrentSnapshot).toBe(false);
  });

  it('never reads another character\'s opportunities or inventory', () => {
    insertAsset(1, 34, 10, JITA);
    seedSnapshot(1, 10, 1);
    seedMarketOrder(34);
    insertOpportunity({ id: 'OPP-MINE', typeId: 34, required: 10 });
    insertOpportunity({ id: 'OPP-THEIRS', typeId: 34, required: 10, characterId: OTHER_CHARACTER_ID });

    const mine = RealOpportunityMatchService.recompute(db as Db, CHARACTER_ID, LINEAGE);
    expect(mine.matches.map((match) => match.opportunityId)).toEqual(['OPP-MINE']);

    const others = RealOpportunityMatchService.recompute(db as Db, OTHER_CHARACTER_ID, OTHER_LINEAGE);
    // The other character has their own opportunity but no snapshot: their row
    // is UNKNOWN and must never inherit THIS character's inventory.
    expect(others.matches.map((match) => match.opportunityId)).toEqual(['OPP-THEIRS']);
    expect(others.matches[0]).toMatchObject({
      heldQuantity: 0,
      accessibleQuantity: 0,
      supportClass: 'UNKNOWN',
      snapshotId: null,
    });
    const otherList = RealOpportunityMatchService.list(db as Db, OTHER_CHARACTER_ID, OTHER_LINEAGE);
    expect(otherList.total).toBe(1);
    expect(otherList.rows[0].opportunity_id).toBe('OPP-THEIRS');
  });
});
