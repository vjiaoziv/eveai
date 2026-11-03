import type { Db } from '../db/sqlite.js';
import { DataCenter } from '../trading/data-center.js';

/**
 * P9.2.2 unified asset location resolver.
 *
 * Resolves an ESI asset location_id against, in order of authority:
 *   1. the snapshot's own item registry (location_id == another item_id means
 *      the asset sits inside that ship/container — an ID-based parent link,
 *      never a name match),
 *   2. the SDE station table (station -> solar system -> region),
 *   3. the SDE solar-system table (system -> constellation -> region),
 *   4. the ESI `location_type` hint captured on the asset row.
 *
 * Anything else stays UNKNOWN/ACCESS_RESTRICTED: the raw id is preserved and
 * no guess is made (task book 5.1/5.3).
 */

export type AssetResolutionStatus = 'RESOLVED' | 'PARTIALLY_RESOLVED' | 'UNKNOWN' | 'ACCESS_RESTRICTED';

export type AssetLocationKind =
  | 'SOLAR_SYSTEM'
  | 'STATION'
  | 'STRUCTURE'
  | 'SHIP'
  | 'CONTAINER'
  | 'UNKNOWN';

export type ResolvedAssetLocation = {
  locationId: number;
  locationType: AssetLocationKind;
  locationName: string | null;
  solarSystemId: number | null;
  solarSystemName: string | null;
  regionId: number | null;
  regionName: string | null;
  parentLocationId: number | null;
  resolutionStatus: AssetResolutionStatus;
  resolutionSource: string;
  raw: Record<string, unknown> | null;
};

/** item_id -> minimal registry entry used for parent climbing. */
export type AssetItemRegistry = Map<number, { typeId: number; locationId: number }>;

type SdeChainRow = {
  name: string;
  system_id: number | null;
  system_name: string | null;
  constellation_id: number | null;
  region_id: number | null;
  region_name: string | null;
};

export class AssetLocationResolver {
  /**
   * Climb location_id -> item_id parent links until the asset reaches a
   * station/system (or the chain goes unresolved). The direct parent is the
   * item that contains it; `parentLocationId` is the outermost container's
   * own location (i.e. where the chain finally points).
   */
  static resolve(
    db: Db,
    locationId: number,
    registry: AssetItemRegistry,
    esiLocationType?: string | null,
    raw: Record<string, unknown> | null = null,
  ): ResolvedAssetLocation {
    // 1) The location itself is a known item (ship / container / cargo bay...):
    // climb to its terminal station/system and keep the direct container link.
    const viaItem = climbViaItems(db, locationId, registry);
    if (viaItem) {
      const terminalResolved = this.resolveTerminal(
        db, viaItem.terminalLocationId, registry, esiLocationType, raw, viaItem.depth,
      );
      if (terminalResolved) {
        return {
          ...terminalResolved,
          locationId,
          locationType: viaItem.kind,
          parentLocationId: viaItem.directParentId,
          resolutionSource: `${terminalResolved.resolutionSource}+snapshot_parent`,
        };
      }
      // Parent chain known but terminal location is not: partial.
      return {
        locationId,
        locationType: viaItem.kind,
        locationName: null,
        solarSystemId: null,
        solarSystemName: null,
        regionId: null,
        regionName: null,
        parentLocationId: viaItem.directParentId,
        resolutionStatus: 'PARTIALLY_RESOLVED',
        resolutionSource: 'snapshot_parent',
        raw,
      };
    }

    // 2/3) Terminal resolution (station / system / structure hint).
    const terminal = this.resolveTerminal(db, locationId, registry, esiLocationType, raw, 0);
    if (terminal) return terminal;

    // 4) Unknown id: keep the raw data, never guess.
    return {
      locationId,
      locationType: 'UNKNOWN',
      locationName: null,
      solarSystemId: null,
      solarSystemName: null,
      regionId: null,
      regionName: null,
      parentLocationId: null,
      resolutionStatus: 'UNKNOWN',
      resolutionSource: 'none',
      raw,
    };
  }

  private static resolveTerminal(
    db: Db,
    locationId: number,
    registry: AssetItemRegistry,
    esiLocationType: string | null | undefined,
    raw: Record<string, unknown> | null,
    depth: number,
  ): ResolvedAssetLocation | null {
    const base = {
      locationId,
      solarSystemId: null as number | null,
      solarSystemName: null as string | null,
      regionId: null as number | null,
      regionName: null as string | null,
      parentLocationId: null as number | null,
      raw,
    };

    const station = db.prepare(`
      SELECT s.name AS name, s.system_id AS system_id, y.name AS system_name,
             c.region_id AS region_id, r.name AS region_name
      FROM sde_stations s
      LEFT JOIN sde_systems y ON y.system_id = s.system_id
      LEFT JOIN sde_constellations c ON c.constellation_id = y.constellation_id
      LEFT JOIN sde_regions r ON r.region_id = c.region_id
      WHERE s.station_id = ?
    `).get(locationId) as SdeChainRow | undefined;
    if (station) {
      return {
        ...base,
        locationType: 'STATION',
        locationName: station.name,
        solarSystemId: station.system_id,
        solarSystemName: station.system_name,
        regionId: station.region_id,
        regionName: station.region_name,
        resolutionStatus: station.system_id !== null && station.region_id !== null ? 'RESOLVED' : 'PARTIALLY_RESOLVED',
        resolutionSource: 'sde_stations',
      };
    }

    const system = db.prepare(`
      SELECT y.name AS name, y.system_id AS system_id, c.region_id AS region_id, r.name AS region_name
      FROM sde_systems y
      LEFT JOIN sde_constellations c ON c.constellation_id = y.constellation_id
      LEFT JOIN sde_regions r ON r.region_id = c.region_id
      WHERE y.system_id = ?
    `).get(locationId) as SdeChainRow | undefined;
    if (system) {
      return {
        ...base,
        locationType: 'SOLAR_SYSTEM',
        locationName: system.name,
        solarSystemId: locationId,
        solarSystemName: system.name,
        regionId: system.region_id,
        regionName: system.region_name,
        resolutionStatus: system.region_id !== null ? 'RESOLVED' : 'PARTIALLY_RESOLVED',
        resolutionSource: 'sde_systems',
      };
    }

    // ESI says this id is a structure (or an item registry entry we could not
    // climb). Player structures need extra ESI lookups we deliberately do not
    // guess at: mark restricted/unknown instead of inventing a name.
    if (esiLocationType === 'structure') {
      return {
        ...base,
        locationType: 'STRUCTURE',
        locationName: null,
        resolutionStatus: 'ACCESS_RESTRICTED',
        resolutionSource: 'esi_location_type',
      };
    }
    if (registry.has(locationId)) {
      // A container/ship whose own registry entry exists but whose terminal
      // location could not be resolved: report the chain as partial.
      return {
        ...base,
        locationType: 'CONTAINER',
        locationName: null,
        resolutionStatus: depth > 0 ? 'PARTIALLY_RESOLVED' : 'UNKNOWN',
        resolutionSource: 'snapshot_parent',
      };
    }
    return null;
  }

  /** Bulk resolve + upsert the resolution cache. Returns keyed results. */
  static resolveMany(
    db: Db,
    locationIds: readonly number[],
    registry: AssetItemRegistry,
    hints: Map<number, string | null> = new Map(),
  ): Map<number, ResolvedAssetLocation> {
    const out = new Map<number, ResolvedAssetLocation>();
    const upsert = db.prepare(`
      INSERT INTO real_asset_locations
        (location_id, location_type, location_name, solar_system_id, solar_system_name,
         region_id, region_name, parent_location_id, resolution_status, resolution_source, raw_json, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(location_id) DO UPDATE SET
        location_type = excluded.location_type,
        location_name = excluded.location_name,
        solar_system_id = excluded.solar_system_id,
        solar_system_name = excluded.solar_system_name,
        region_id = excluded.region_id,
        region_name = excluded.region_name,
        parent_location_id = excluded.parent_location_id,
        resolution_status = excluded.resolution_status,
        resolution_source = excluded.resolution_source,
        raw_json = excluded.raw_json,
        resolved_at = excluded.resolved_at
    `);
    const tx = db.transaction(() => {
      for (const id of new Set(locationIds)) {
        const resolved = this.resolve(db, id, registry, hints.get(id) ?? null, null);
        out.set(id, resolved);
        upsert.run(
          resolved.locationId, resolved.locationType, resolved.locationName,
          resolved.solarSystemId, resolved.solarSystemName,
          resolved.regionId, resolved.regionName,
          resolved.parentLocationId, resolved.resolutionStatus, resolved.resolutionSource,
          resolved.raw ? JSON.stringify(resolved.raw) : null,
        );
      }
    });
    tx();
    return out;
  }
}

type ClimbResult = {
  /** Where the chain ends: a station/system id (or an unresolved id). */
  terminalLocationId: number;
  /** The item that directly contains the resolved location, if any. */
  directParentId: number | null;
  parentTypeId: number | null;
  kind: AssetLocationKind;
  depth: number;
};

function climbViaItems(
  db: Db,
  locationId: number,
  registry: AssetItemRegistry,
): ClimbResult | null {
  const self = registry.get(locationId);
  if (!self) return null;
  const seen = new Set<number>();
  let current = locationId;
  let directParentId: number | null = null;
  let parentTypeId: number | null = null;
  let depth = 0;
  while (registry.has(current)) {
    if (seen.has(current)) break; // cycle guard
    seen.add(current);
    const entry = registry.get(current)!;
    const next = entry.locationId;
    depth += 1;
    if (registry.has(next)) {
      if (directParentId === null) {
        directParentId = next;
        parentTypeId = registry.get(next)!.typeId;
      }
      current = next;
      continue;
    }
    // `next` is a terminal location (station/system/unknown): stop here.
    return {
      terminalLocationId: next,
      directParentId,
      parentTypeId,
      kind: classifyItemKind(db, self.typeId),
      depth,
    };
  }
  return {
    terminalLocationId: current,
    directParentId,
    parentTypeId,
    kind: classifyItemKind(db, self.typeId),
    depth,
  };
}

/** SDE category/group based item class; never name-matches parent links. */
function classifyItemKind(db: Db, typeId: number): AssetLocationKind {
  const meta = DataCenter.getItemMetadata(db, typeId);
  const haystack = `${meta?.category_name || ''} ${meta?.group_name || ''}`.toLowerCase();
  return haystack.includes('ship') ? 'SHIP' : 'CONTAINER';
}
