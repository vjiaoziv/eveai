import { useCallback, useEffect, useState } from 'react';
import { webApi } from '../api';
import { ChartIcon, MenuIcon } from '../icons';
import { LocaleSwitch, useI18n } from '../i18n';

type AssetTab = 'overview' | 'characters' | 'inventory' | 'detail' | 'changes' | 'valuation' | 'opportunities';

type OverviewCharacter = {
  characterId: number;
  characterName: string | null;
  currentAssetItems: number;
  latestSnapshot: Record<string, unknown> | null;
  lastJob: Record<string, unknown> | null;
  latestValuation: Record<string, unknown> | null;
  valuationFreshness?: {
    status: 'CURRENT' | 'STALE' | 'NO_VALUATION' | 'NO_LATEST_SNAPSHOT' | string;
    latestSnapshotId: string | null;
    valuationSnapshotId: string | null;
    valuationItems: number;
    currentAssetItems: number;
    message: string;
  };
  syncEnabled: boolean;
  bucketSummary: Array<{ bucket: string; labelZh: string; items: number; quantity: number }>;
};

type AssetOverview = {
  totals: { items: number; characters: number; withSnapshot: number };
  characters: OverviewCharacter[];
  valuationNote: string;
};

type InventoryRow = {
  itemId: number;
  typeId: number;
  quantity: number;
  typeName: string;
  typeNameZh: string | null;
  bucketLabelZh: string;
  resolvedType: string | null;
  resolvedName: string | null;
  solarSystemName: string | null;
  regionName: string | null;
  resolutionStatus: string | null;
  tag: string | null;
  marketReferenceValue: number | null;
  bidLiquidationNet: number | null;
  valuationStatuses: string[];
};

type AssetMatch = Record<string, unknown> & {
  opportunity_id: string;
  type_id: number;
  held_quantity: number;
  accessible_quantity: number;
  required_quantity: number;
  support_class: string;
  supportClassZh: string;
  needs_transport: boolean;
  state: string;
  strategy: string;
  type_name: string | null;
  buy_location_name: string | null;
  sell_location_name: string | null;
  fee_net_profit: number;
  comprehensive_net_profit: number | null;
  comprehensive_status: string;
  locations: Array<Record<string, unknown>>;
};

const num = (value: unknown, digits = 2): string =>
  typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString('zh-CN', { maximumFractionDigits: digits })
    : 'N/A';

const dateTime = (value: unknown): string => {
  if (typeof value !== 'string' || !value) return 'N/A';
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const withZone = /Z|[+-]\d{2}:\d{2}$/.test(normalized) ? normalized : `${normalized}Z`;
  const parsed = new Date(withZone);
  return Number.isNaN(parsed.getTime())
    ? value.replace('T', ' ').slice(0, 19)
    : parsed.toLocaleString('zh-CN', { hour12: false });
};



type SnapshotDetail = {
  snapshot: Record<string, any>;
  items: Array<Record<string, any>>;
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
};

type Props = { onMenu: () => void; csrfToken: string };

export function AssetScreen({ onMenu, csrfToken }: Props) {
  const { t } = useI18n();

  // Label maps live inside the component: they are built from t(), which only
  // exists in render scope (the same lesson as pageLabels in P93AccountingPanel).
const TAG_LABELS: Record<string, string> = {
  SELF_USE: t('assetTagSelfUse'), FOR_SALE: t('assetTagForSale'), PRODUCTION: t('assetTagProduction'), MISSION: t('assetTagMission'),
  SPARE: t('assetTagSpare'), TRADE_STOCK: t('assetTagTradeStock'), HOLD: t('assetTagHold'),
};

const CHANGE_LABELS: Record<string, string> = {
  ADDED: t('assetChangeAdded'), QTY_INCREASED: t('assetChangeQtyUp'), QTY_DECREASED: t('assetChangeQtyDown'), MOVED: t('assetChangeMoved'),
  REMOVED: t('assetChangeRemoved'), REAPPEARED: t('assetChangeReappeared'), CONTAINER_CHANGED: t('assetChangeContainer'),
};

const BUCKETS = [
  '', 'SHIPS', 'SHIP_MODULES', 'DRONES', 'AMMO', 'ORES_MINERALS', 'MANUFACTURING',
  'BPO', 'BPC', 'MISSION', 'IMPLANTS', 'CONSUMABLES', 'TRADING_GOODS', 'OTHER', 'UNKNOWN',
];

const BUCKET_LABELS: Record<string, string> = {
  SHIPS: t('ship'), SHIP_MODULES: t('assetCatShipModules'), DRONES: t('marketAttrGroup_drones'), AMMO: t('assetCatAmmo'),
  ORES_MINERALS: t('assetCatOres'), MANUFACTURING: t('assetCatManufacturing'), BPO: t('assetCatBpo'),
  BPC: t('assetCatBpc'), MISSION: t('assetCatMission'), IMPLANTS: t('assetCatImplants'),
  CONSUMABLES: t('assetCatConsumables'), TRADING_GOODS: t('assetCatTradingGoods'), OTHER: t('assetCatOther'), UNKNOWN: t('assetCatUnknown'),
};
  const [tab, setTab] = useState<AssetTab>('overview');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [overview, setOverview] = useState<AssetOverview | null>(null);
  const [characterId, setCharacterId] = useState<number | null>(null);
  const [inventory, setInventory] = useState<{ rows: InventoryRow[]; total: number; limit: number; offset: number } | null>(null);
  const [selectedItem, setSelectedItem] = useState<Record<string, any> | null>(null);
  const [snapshots, setSnapshots] = useState<any[]>([]);
  const [changes, setChanges] = useState<any[]>([]);
  const [changeTotal, setChangeTotal] = useState(0);
  const [totalsHistory, setTotalsHistory] = useState<any[]>([]);
  const [snapshotDetail, setSnapshotDetail] = useState<SnapshotDetail | null>(null);
  const [snapshotPage, setSnapshotPage] = useState({ snapshotId: '', offset: 0, limit: 500 });
  const [compareResult, setCompareResult] = useState<Record<string, any> | null>(null);
  const [valuations, setValuations] = useState<Record<string, any> | null>(null);
  const [valuationDetail, setValuationDetail] = useState<Record<string, any> | null>(null);
  const [matches, setMatches] = useState<{ rows: AssetMatch[]; total: number } | null>(null);
  const [inventoryQuery, setInventoryQuery] = useState({
    q: '', bucket: '', sort: 'quantity', order: 'desc', offset: 0, limit: 100, tradable: '',
  });
  const [changeQuery, setChangeQuery] = useState({ changeType: '', from: '', to: '' });
  const [compareFrom, setCompareFrom] = useState('');
  const [compareTo, setCompareTo] = useState('');

  const loadOverview = useCallback(async () => {
    const payload = await webApi.assets.overview() as AssetOverview;
    setOverview(payload);
    setCharacterId((current) => current ?? payload.characters[0]?.characterId ?? null);
    return payload;
  }, []);

  const loadInventory = useCallback(async () => {
    if (characterId === null) return;
    setInventory(await webApi.assets.inventory({
      characterId,
      q: inventoryQuery.q || undefined,
      bucket: inventoryQuery.bucket || undefined,
      sort: inventoryQuery.sort,
      order: inventoryQuery.order,
      offset: inventoryQuery.offset,
      limit: inventoryQuery.limit,
      tradable: inventoryQuery.tradable || undefined,
    }) as { rows: InventoryRow[]; total: number; limit: number; offset: number });
  }, [characterId, inventoryQuery]);

  const loadChanges = useCallback(async () => {
    if (characterId === null) return;
    const [snapshotPayload, changePayload, totalPayload] = await Promise.all([
      webApi.assets.snapshots({ characterId, limit: 200 }),
      webApi.assets.changes({
        characterId,
        changeType: changeQuery.changeType || undefined,
        from: changeQuery.from || undefined,
        to: changeQuery.to || undefined,
        limit: 200,
      }),
      webApi.assets.historyTotals(characterId, 200),
    ]) as Array<Record<string, any>>;
    setSnapshots(snapshotPayload.snapshots ?? []);
    setChanges(changePayload.rows ?? []);
    setChangeTotal(Number(changePayload.total ?? 0));
    setTotalsHistory(totalPayload.snapshots ?? []);
    const completed = (snapshotPayload.snapshots ?? []).filter((row: any) => row.status === 'COMPLETED');
    setCompareFrom((current) => current || completed[1]?.snapshot_id || '');
    setCompareTo((current) => current || completed[0]?.snapshot_id || '');
    setSnapshotPage((current) => ({
      ...current,
      snapshotId: completed.some((row: any) => row.snapshot_id === current.snapshotId)
        ? current.snapshotId
        : (completed[0]?.snapshot_id || ''),
      offset: 0,
    }));
  }, [characterId, changeQuery]);

  const loadSnapshotPage = async (snapshotId: string, offset: number) => {
    if (!snapshotId) return;
    setBusy(true);
    setError(null);
    try {
      const payload = await webApi.assets.snapshot(snapshotId, {
        limit: snapshotPage.limit,
        offset,
      }) as SnapshotDetail;
      setSnapshotDetail(payload);
      setSnapshotPage((current) => ({ ...current, snapshotId, offset }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('assetSnapshotLoadFailed'));
    } finally {
      setBusy(false);
    }
  };

  const loadValuation = useCallback(async () => {
    if (characterId === null) return;
    const payload = await webApi.assets.valuations(characterId, 50) as Record<string, any>;
    setValuations(payload);
    const latest = payload.runs?.find((row: any) => row.status === 'COMPLETED');
    setValuationDetail(latest
      ? await webApi.assets.valuation(latest.valuation_id) as Record<string, any>
      : null);
  }, [characterId]);

  const loadMatches = useCallback(async () => {
    if (characterId === null) return;
    setMatches(await webApi.assets.opportunityMatches({ characterId, limit: 500 }) as { rows: AssetMatch[]; total: number });
  }, [characterId]);

  const loadTab = useCallback(async (nextTab: AssetTab) => {
    setError(null);
    setBusy(true);
    try {
      if (nextTab === 'overview' || nextTab === 'characters') await loadOverview();
      if (nextTab === 'inventory') await loadInventory();
      if (nextTab === 'changes') await loadChanges();
      if (nextTab === 'valuation') await loadValuation();
      if (nextTab === 'opportunities') await loadMatches();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('assetLoadFailed'));
    } finally {
      setBusy(false);
    }
  }, [loadChanges, loadInventory, loadMatches, loadOverview, loadValuation]);

  useEffect(() => { void loadTab(tab); }, [tab, loadTab]);

  const runAction = useCallback(async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(success);
      await loadTab(tab);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('assetActionFailed'));
    } finally {
      setBusy(false);
    }
  }, [loadTab, tab]);

  const syncCharacter = (targetId: number) =>
    runAction(() => webApi.assets.sync(targetId, csrfToken), t('assetSyncDone'));
  const runValuation = () => characterId === null
    ? Promise.resolve()
    : runAction(() => webApi.assets.runValuation({ characterId }, csrfToken), t('assetValuationDone'));
  const recomputeMatches = () => characterId === null
    ? Promise.resolve()
    : runAction(() => webApi.assets.recomputeMatches(characterId, csrfToken), t('assetMatchesRecomputed'));
  const saveTag = (itemId: number, tag: string) =>
    runAction(() => webApi.assets.setTag(itemId, tag || null, csrfToken), t('assetTagSaved'));

  const openItem = async (itemId: number) => {
    setBusy(true);
    setError(null);
    try {
      const payload = await webApi.assets.item(itemId) as Record<string, any>;
      setSelectedItem(payload.item);
      setTab('detail');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('assetDetailLoadFailed'));
    } finally {
      setBusy(false);
    }
  };

  const compareSnapshots = () => runAction(async () => {
    if (!compareFrom || !compareTo) return;
    setCompareResult(await webApi.assets.compareSnapshots(compareFrom, compareTo) as Record<string, any>);
  }, t('assetCompareDone'));

  const characters = overview?.characters ?? [];
  const latestSync = characters
    .map((row) => row.lastJob?.completedAt ?? row.lastJob?.completed_at ?? row.latestSnapshot?.completed_at)
    .filter(Boolean).sort().at(-1) ?? null;
  const valuationTotals = characters.map((row) => row.latestValuation).filter(Boolean);
  const marketReferenceTotal = valuationTotals.reduce((sum, row) => sum + Number(row?.marketReferenceValue ?? 0), 0);
  const liquidationTotal = valuationTotals.reduce((sum, row) => sum + Number(row?.bidLiquidationNet ?? 0), 0);
  const unknownItems = valuationTotals.reduce((sum, row) =>
    sum + Number(row?.items ?? 0) - Number(row?.itemsWithReference ?? 0), 0);
  const staleValuationCharacters = characters.filter((row) => row.valuationFreshness?.status === 'STALE');
  const staleValuationSummary = staleValuationCharacters
    .map((row) => String(row.characterName || row.characterId) + ': ' + String(row.valuationFreshness?.message ?? ''))
    .join('；');
  const selectedCharacter = characters.find((row) => row.characterId === characterId) ?? null;
  const valuationRows = valuationDetail?.items ?? [];
  const unknownValuation = valuationRows.filter((row: any) =>
    (row.statuses ?? []).includes('LOCATION_UNKNOWN') || (row.statuses ?? []).includes('NO_MARKET_DATA')).length;
  const depthShortfall = valuationRows.filter((row: any) =>
    (row.statuses ?? []).includes('INSUFFICIENT_DEPTH')).length;
  const valuationCoverage = valuationRows.length > 0
    ? ((valuationRows.length - unknownValuation) / valuationRows.length) * 100
    : null;

  const tabs: Array<{ id: AssetTab; label: string }> = [
    { id: 'overview', label: t('assetTabOverview') },
    { id: 'characters', label: t('assetTabCharacters') },
    { id: 'inventory', label: t('assetTabInventory') },
    { id: 'detail', label: t('assetTabDetail') },
    { id: 'changes', label: t('assetTabChanges') },
    { id: 'valuation', label: t('assetTabValuation') },
    { id: 'opportunities', label: t('assetTabOpportunities') },
  ];

  return (
    <section className="market-screen">
      <header className="market-screen__topbar asset-screen__topbar">
        <button className="icon-button" type="button" onClick={onMenu} aria-label={t('openMenu')}><MenuIcon size={20} /></button>
        <h1><ChartIcon size={18} /> {t('assetTitle')}</h1>
        <span className="status-pill">{t('assetModePill')}</span>
        <select
          className="market-select"
          value={characterId ?? ''}
          onChange={(event) => setCharacterId(Number(event.target.value))}
          aria-label={t('assetSelectCharacter')}
        >
          {characters.map((row) => (
            <option key={row.characterId} value={row.characterId}>{row.characterName || t('assetCharacterLabel', { value: String(row.characterId) })}</option>
          ))}
        </select>
        <LocaleSwitch />
        <button className="button button--secondary" type="button" disabled={busy || characterId === null} onClick={() => characterId !== null && void syncCharacter(characterId)}>
          {t('assetSyncCurrent')}
        </button>
        <button className="button button--secondary" type="button" disabled={busy} onClick={() => void loadTab(tab)}>{t('refresh')}</button>
      </header>

      <nav className="market-tabs" aria-label={t('assetViewNav')}>
        {tabs.map((item) => (
          <button key={item.id} type="button" className={tab === item.id ? 'market-tabs__tab market-tabs__tab--active' : 'market-tabs__tab'} onClick={() => setTab(item.id)}>
            {item.label}
          </button>
        ))}
      </nav>

      {error ? <div className="screen-error" role="alert">{error}</div> : null}
      {notice ? <div className="screen-success" role="status">{notice}</div> : null}
      {busy ? <p>{t('assetProcessing')}</p> : null}
      {!overview ? <div className="app-loading" aria-label={t('assetLoading')}><span /><span /><span /></div> : null}

      {overview && tab === 'overview' ? (
        <>
          <div className="metric-grid">
            <div className="metric-card"><span>{t('assetAuthorizedCharacters')}</span><strong>{overview.totals.characters}</strong></div>
            <div className="metric-card"><span>{t('assetLastSync')}</span><strong>{dateTime(latestSync)}</strong></div>
            <div className="metric-card"><span>{t('assetItemRows')}</span><strong>{num(overview.totals.items, 0)}</strong></div>
            <div className="metric-card"><span>{t('assetFullSnapshotCharacters')}</span><strong>{overview.totals.withSnapshot} / {overview.totals.characters}</strong></div>
            <div className="metric-card"><span>{t('assetMarketReference')}</span><strong>{num(marketReferenceTotal, 2)}</strong></div>
            <div className="metric-card"><span>{t('assetBidLiquidation')}</span><strong>{num(liquidationTotal, 2)}</strong></div>
            <div className="metric-card"><span>{t('assetUnknownValuedItems')}</span><strong>{num(unknownItems, 0)}</strong></div>
            <div className="metric-card"><span>{t('assetRealTrades')}</span><strong>DISABLED</strong></div>
          </div>
          {staleValuationCharacters.length > 0 ? (
            <div className="support-note support-note--warn" role="status">
              <strong>{t('assetValuationStale')}</strong>{staleValuationSummary}{t('assetValuationStaleNote')}
            </div>
          ) : null}
          <p>{t('assetValuationBasesNoSum')}{overview.valuationNote}</p>
          <h2>{t('assetCategoryInventory')}</h2>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>{t('profileGroup')}</th><th>{t('assetItemRow')}</th><th>{t('colTotalQuantity')}</th></tr></thead>
              <tbody>
                {selectedCharacter?.bucketSummary.map((row) => (
                  <tr key={row.bucket}><td>{row.labelZh}</td><td>{row.items}</td><td>{num(row.quantity, 0)}</td></tr>
                ))}
                {!selectedCharacter?.bucketSummary.length ? <tr><td colSpan={3}>{t('assetNoCurrentInventory')}</td></tr> : null}
              </tbody>
            </table>
          </div>
          <h2>{t('assetSyncAndValuation')}</h2>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>{t('assetCharacter')}</th><th>{t('assetCurrentItems')}</th><th>{t('assetRecentJobs')}</th><th>{t('assetFullSnapshot')}</th><th>{t('assetMarketRefShort')}</th><th>{t('assetExecutableSell')}</th></tr></thead>
              <tbody>
                {characters.map((row) => (
                  <tr key={row.characterId}>
                    <td>{row.characterName || row.characterId}</td>
                    <td>{row.currentAssetItems}</td>
                    <td>{String(row.lastJob?.status ?? 'N/A')} · {dateTime(row.lastJob?.completedAt ?? row.lastJob?.completed_at)}</td>
                    <td>{row.latestSnapshot ? t('assetRowsLine', { time: dateTime(row.latestSnapshot.completed_at), rows: String(row.latestSnapshot.total_items) }) : t('paperNoRiskFlags')}</td>
                    <td>{num(row.latestValuation?.marketReferenceValue, 2)}</td>
                    <td>{num(row.latestValuation?.bidLiquidationNet, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {overview && tab === 'characters' ? (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th>{t('assetCharacter')}</th><th>{t('colCharacterId')}</th><th>{t('colSyncStatus')}</th><th>{t('assetLastSynced')}</th><th>{t('assetItemCount')}</th><th>{t('assetValuationSummary')}</th><th>{t('colAction')}</th></tr></thead>
            <tbody>
              {characters.map((row) => (
                <tr key={row.characterId}>
                  <td>{row.characterName || t('assetUnknownCharacter')}</td>
                  <td>{row.characterId}</td>
                  <td>{String(row.lastJob?.status ?? (row.syncEnabled ? t('assetPendingSync') : t('assetAutoSyncOff')))}</td>
                  <td>{dateTime(row.lastJob?.completedAt ?? row.lastJob?.completed_at ?? row.latestSnapshot?.completed_at)}</td>
                  <td>{row.currentAssetItems}</td>
                  <td>
                    {t('assetRefLabel', { value: num(row.latestValuation?.marketReferenceValue, 2) })} ·
                    {' '}{t('assetExecutableLabel', { value: num(row.latestValuation?.bidLiquidationNet, 2) })}
                  </td>
                  <td><button type="button" disabled={busy} onClick={() => void syncCharacter(row.characterId)}>{t('assetSyncAlone')}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {tab === 'inventory' ? (
        <>
          <div className="toolbar">
            <input
              className="market-input"
              placeholder={t('assetSearchPlaceholder')}
              value={inventoryQuery.q}
              onChange={(event) => setInventoryQuery((current) => ({ ...current, q: event.target.value, offset: 0 }))}
            />
            <select
              className="market-select"
              value={inventoryQuery.bucket}
              onChange={(event) => setInventoryQuery((current) => ({ ...current, bucket: event.target.value, offset: 0 }))}
            >
              {BUCKETS.map((bucket) => <option key={bucket} value={bucket}>{bucket ? BUCKET_LABELS[bucket] : t('assetAllCategories')}</option>)}
            </select>
            <select
              className="market-select"
              value={inventoryQuery.tradable}
              onChange={(event) => setInventoryQuery((current) => ({ ...current, tradable: event.target.value, offset: 0 }))}
            >
              <option value="">{t('assetAllTradeStates')}</option>
              <option value="true">{t('assetHasOrders')}</option>
              <option value="false">{t('assetNoOrders')}</option>
            </select>
            <select
              className="market-select"
              value={`${inventoryQuery.sort}:${inventoryQuery.order}`}
              onChange={(event) => {
                const [sort, order] = event.target.value.split(':');
                setInventoryQuery((current) => ({ ...current, sort, order, offset: 0 }));
              }}
            >
              <option value="quantity:desc">{t('assetSortQtyDesc')}</option>
              <option value="quantity:asc">{t('assetSortQtyAsc')}</option>
              <option value="name:asc">{t('assetSortName')}</option>
              <option value="type:asc">{t('assetSortTypeId')}</option>
            </select>
            <button type="button" disabled={busy} onClick={() => void loadInventory()}>{t('assetQuery')}</button>
          </div>
          <p>{t('assetInventoryTotalLine', { count: String(inventory?.total ?? 0) })}</p>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('marketWatchlistItem')}</th><th>{t('marketQuantity')}</th><th>{t('profileGroup')}</th><th>{t('colLocation')}</th><th>{t('assetMarketRefShort')}</th>
                  <th>{t('assetExecutableSell')}</th><th>{t('assetValuationStatus')}</th><th>{t('assetLocalTag')}</th><th>{t('colAction')}</th>
                </tr>
              </thead>
              <tbody>
                {(inventory?.rows ?? []).map((row) => (
                  <tr key={row.itemId}>
                    <td>
                      <img
                        src={`https://images.evetech.net/types/${row.typeId}/icon?size=64`}
                        alt=""
                        width={32}
                        height={32}
                        loading="lazy"
                        onError={(event) => { (event.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }}
                      />
                      {' '}{row.typeNameZh || row.typeName}<br /><small>Type {row.typeId} · Item {row.itemId}</small>
                    </td>
                    <td>{num(row.quantity, 0)}</td>
                    <td>{row.bucketLabelZh}</td>
                    <td>
                      {row.regionName || t('assetRegionUnknown')}<br />
                      <small>{row.solarSystemName || t('assetSystemUnknown')} · {row.resolvedName || row.resolvedType || t('assetPlaceUnknown')} · {row.resolutionStatus}</small>
                    </td>
                    <td>{num(row.marketReferenceValue, 2)}</td>
                    <td>{num(row.bidLiquidationNet, 2)}</td>
                    <td>{row.valuationStatuses.length ? row.valuationStatuses.join(' / ') : t('assetNotValued')}</td>
                    <td>{row.tag ? TAG_LABELS[row.tag] || row.tag : t('paperNoRiskFlags')}</td>
                    <td><button type="button" onClick={() => void openItem(row.itemId)}>{t('p93Detail')}</button></td>
                  </tr>
                ))}
                {!inventory?.rows.length ? <tr><td colSpan={9}>{t('assetNoInventoryMatches')}</td></tr> : null}
              </tbody>
            </table>
          </div>
          <div className="toolbar">
            <button
              type="button"
              disabled={busy || inventoryQuery.offset <= 0}
              onClick={() => setInventoryQuery((current) => ({ ...current, offset: Math.max(0, current.offset - current.limit) }))}
            >
              {t('p93PrevPage')}
            </button>
            <span>{t('assetPageOf', { page: String(Math.floor(inventoryQuery.offset / inventoryQuery.limit) + 1) })}</span>
            <button
              type="button"
              disabled={busy || (inventory?.offset ?? 0) + (inventory?.limit ?? 0) >= (inventory?.total ?? 0)}
              onClick={() => setInventoryQuery((current) => ({ ...current, offset: current.offset + current.limit }))}
            >
              {t('p93NextPage')}
            </button>
          </div>
        </>
      ) : null}

      {tab === 'detail' ? (
        selectedItem ? (
          <>
            <div className="metric-grid">
              <div className="metric-card"><span>{t('assetItemName')}</span><strong>{selectedItem.typeNameZh || selectedItem.typeName}</strong></div>
              <div className="metric-card"><span>Type ID</span><strong>{selectedItem.typeId}</strong></div>
              <div className="metric-card"><span>Item ID</span><strong>{selectedItem.itemId}</strong></div>
              <div className="metric-card"><span>{t('marketQuantity')}</span><strong>{num(selectedItem.quantity, 0)}</strong></div>
              <div className="metric-card"><span>{t('profileGroup')}</span><strong>{selectedItem.bucketLabelZh}</strong></div>
              <div className="metric-card"><span>{t('assetMarketRefShort')}</span><strong>{num(selectedItem.marketReferenceValue, 2)}</strong></div>
              <div className="metric-card"><span>{t('assetBidDepthExecutable')}</span><strong>{num(selectedItem.bidLiquidationNet, 2)}</strong></div>
              <div className="metric-card"><span>{t('assetLocalTag')}</span><strong>{selectedItem.tag ? TAG_LABELS[selectedItem.tag] || selectedItem.tag : t('paperNoRiskFlags')}</strong></div>
            </div>
            <h2>{t('assetLocationAndContainer')}</h2>
            <p>
              {selectedItem.regionName || t('assetRegionUnknown')} · {selectedItem.solarSystemName || t('assetSystemUnknown')} ·
              {' '}{selectedItem.resolvedName || selectedItem.resolvedType || t('assetPlaceUnknown')} ·
              {' '}{selectedItem.locationType || 'container UNKNOWN'} · {selectedItem.locationFlag || 'flag UNKNOWN'} ·
              {' '}{selectedItem.resolutionStatus || 'UNKNOWN'}
            </p>
            <h2>{t('assetValuationStatus')}</h2>
            <p>{selectedItem.valuationStatuses?.length ? selectedItem.valuationStatuses.join(' / ') : t('assetNoCompletedValuation')}</p>
            <h2>{t('assetLocalTag')}</h2>
            <div className="toolbar">
              <select
                className="market-select"
                value={selectedItem.tag ?? ''}
                onChange={(event) => void saveTag(selectedItem.itemId, event.target.value)}
              >
                <option value="">{t('assetNoTag')}</option>
                {Object.entries(TAG_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <button type="button" onClick={() => setTab('inventory')}>{t('assetBackToInventory')}</button>
            </div>
            <h2>{t('assetSnapshotHistory')}</h2>
            <div className="data-table-wrap">
              <table className="data-table">
                <thead><tr><th>{t('colSnapshot')}</th><th>{t('colTime')}</th><th>{t('marketQuantity')}</th><th>{t('colLocation')}</th><th>{t('profileStatus')}</th></tr></thead>
                <tbody>
                  {(selectedItem.snapshotHistory ?? []).map((row: any) => (
                    <tr key={row.snapshot_id}>
                      <td>{row.snapshot_id}</td>
                      <td>{dateTime(row.completed_at)}</td>
                      <td>{row.quantity}</td>
                      <td>{row.location_name || row.location_id}</td>
                      <td>{row.status}</td>
                    </tr>
                  ))}
                  {!selectedItem.snapshotHistory?.length ? <tr><td colSpan={5}>{t('assetNoSnapshotHistory')}</td></tr> : null}
                </tbody>
              </table>
            </div>
            <h2>{t('assetHistoryChanges')}</h2>
            <div className="data-table-wrap">
              <table className="data-table">
                <thead><tr><th>{t('colChange')}</th><th>{t('assetQtyBefore')}</th><th>{t('assetQtyAfter')}</th><th>{t('assetLocationBefore')}</th><th>{t('assetLocationAfter')}</th><th>{t('colSource')}</th><th>{t('colTime')}</th></tr></thead>
                <tbody>
                  {(selectedItem.changeHistory ?? []).map((row: any) => (
                    <tr key={row.change_id}>
                      <td>{CHANGE_LABELS[row.change_type] || row.change_type}</td>
                      <td>{row.prev_quantity ?? 'N/A'}</td>
                      <td>{row.new_quantity ?? 'N/A'}</td>
                      <td>{row.prev_location_id ?? 'N/A'}</td>
                      <td>{row.new_location_id ?? 'N/A'}</td>
                      <td>{row.source_class} · {row.confidence}</td>
                      <td>{dateTime(row.detected_at)}</td>
                    </tr>
                  ))}
                  {!selectedItem.changeHistory?.length ? <tr><td colSpan={7}>{t('assetNoObservedChanges')}</td></tr> : null}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div className="workspace-empty">
            <h2>{t('assetNoItemSelected')}</h2>
            <p>{t('assetOpenItemFirst')}</p>
            <button type="button" onClick={() => setTab('inventory')}>{t('assetBackToInventoryList')}</button>
          </div>
        )
      ) : null}

      {tab === 'changes' ? (
        <>
          <div className="toolbar">
            <select
              className="market-select"
              value={changeQuery.changeType}
              onChange={(event) => setChangeQuery((current) => ({ ...current, changeType: event.target.value }))}
            >
              <option value="">{t('assetAllChanges')}</option>
              {Object.entries(CHANGE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <label>{t('colFrom')}<input type="date" value={changeQuery.from} onChange={(event) => setChangeQuery((current) => ({ ...current, from: event.target.value }))} /></label>
            <label>{t('colTo')}<input type="date" value={changeQuery.to} onChange={(event) => setChangeQuery((current) => ({ ...current, to: event.target.value }))} /></label>
            <button type="button" disabled={busy} onClick={() => void loadChanges()}>{t('assetQueryChanges')}</button>
          </div>
          <p>{t('assetChangeTotalLine', { count: String(changeTotal) })}</p>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>{t('colChange')}</th><th>{t('marketWatchlistItem')}</th><th>{t('marketQuantity')}</th><th>{t('assetChangeMoved')}</th><th>{t('assetSourceConfidence')}</th><th>{t('colSnapshot')}</th><th>{t('colTime')}</th></tr></thead>
              <tbody>
                {changes.map((row) => (
                  <tr key={row.change_id}>
                    <td>{row.changeLabelZh || CHANGE_LABELS[row.change_type] || row.change_type}</td>
                    <td>{row.type_name || row.type_id}<br /><small>Item {row.item_id}</small></td>
                    <td>{row.prev_quantity ?? 'N/A'} → {row.new_quantity ?? 'N/A'}</td>
                    <td>{row.prev_location_name || row.prev_location_id || 'N/A'} → {row.new_location_name || row.new_location_id || 'N/A'}</td>
                    <td>{row.source_class} · {row.confidence}</td>
                    <td>{row.from_snapshot_id || 'N/A'} → {row.to_snapshot_id}</td>
                    <td>{dateTime(row.detected_at)}</td>
                  </tr>
                ))}
                {!changes.length ? <tr><td colSpan={7}>{t('assetNoChangeMatches')}</td></tr> : null}
              </tbody>
            </table>
          </div>

          <h2>{t('assetSnapshotItems')}</h2>
          <div className="toolbar">
            <select
              className="market-select"
              value={snapshotPage.snapshotId}
              onChange={(event) => {
                setSnapshotDetail(null);
                setSnapshotPage((current) => ({ ...current, snapshotId: event.target.value, offset: 0 }));
              }}
            >
              <option value="">{t('assetSnapshotSelect')}</option>
              {snapshots.filter((row) => row.status === 'COMPLETED').map((row) => (
                <option key={row.snapshot_id} value={row.snapshot_id}>{t('assetRowsLine', { time: dateTime(row.completed_at), rows: String(row.total_items) })}</option>
              ))}
            </select>
            <button type="button" disabled={busy || !snapshotPage.snapshotId} onClick={() => void loadSnapshotPage(snapshotPage.snapshotId, 0)}>
              {t('assetSnapshotLoad')}
            </button>
          </div>
          {snapshotDetail ? (
            <>
              <p>{t('assetSnapshotPageStatus', {
                from: String(snapshotDetail.offset + (snapshotDetail.items.length ? 1 : 0)),
                to: String(snapshotDetail.offset + snapshotDetail.items.length),
                total: String(snapshotDetail.total),
              })}</p>
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead><tr><th>Item ID</th><th>Type ID</th><th>{t('marketQuantity')}</th><th>{t('colLocation')}</th></tr></thead>
                  <tbody>
                    {snapshotDetail.items.map((row) => (
                      <tr key={row.item_id}>
                        <td>{row.item_id}</td>
                        <td>{row.type_id}</td>
                        <td>{row.quantity}</td>
                        <td>{row.location_id}</td>
                      </tr>
                    ))}
                    {!snapshotDetail.items.length ? <tr><td colSpan={4}>{t('assetNoSnapshotHistory')}</td></tr> : null}
                  </tbody>
                </table>
              </div>
              <div className="toolbar">
                <button
                  type="button"
                  disabled={busy || snapshotDetail.offset <= 0}
                  onClick={() => void loadSnapshotPage(snapshotDetail.snapshot.snapshot_id, Math.max(0, snapshotDetail.offset - snapshotDetail.limit))}
                >
                  {t('p93PrevPage')}
                </button>
                <span>{t('assetSnapshotPageStatus', {
                  from: String(snapshotDetail.offset + (snapshotDetail.items.length ? 1 : 0)),
                  to: String(snapshotDetail.offset + snapshotDetail.items.length),
                  total: String(snapshotDetail.total),
                })}</span>
                <button
                  type="button"
                  disabled={busy || !snapshotDetail.hasMore || snapshotDetail.nextOffset === null}
                  onClick={() => void loadSnapshotPage(snapshotDetail.snapshot.snapshot_id, snapshotDetail.nextOffset ?? snapshotDetail.offset + snapshotDetail.limit)}
                >
                  {t('p93NextPage')}
                </button>
              </div>
            </>
          ) : null}

          <h2>{t('assetCompareSnapshots')}</h2>
          <div className="toolbar">
            <select className="market-select" value={compareFrom} onChange={(event) => setCompareFrom(event.target.value)}>
              <option value="">{t('assetFromSnapshot')}</option>
              {snapshots.filter((row) => row.status === 'COMPLETED').map((row) => (
                <option key={row.snapshot_id} value={row.snapshot_id}>{t('assetRowsLine', { time: dateTime(row.completed_at), rows: String(row.total_items) })}</option>
              ))}
            </select>
            <select className="market-select" value={compareTo} onChange={(event) => setCompareTo(event.target.value)}>
              <option value="">{t('assetToSnapshot')}</option>
              {snapshots.filter((row) => row.status === 'COMPLETED').map((row) => (
                <option key={row.snapshot_id} value={row.snapshot_id}>{t('assetRowsLine', { time: dateTime(row.completed_at), rows: String(row.total_items) })}</option>
              ))}
            </select>
            <button type="button" disabled={busy || !compareFrom || !compareTo || compareFrom === compareTo} onClick={() => void compareSnapshots()}>
              {t('assetCompare')}
            </button>
          </div>
          {compareResult ? (
            <>
              <p>
                {t('assetCompareSummary')}
                {Object.entries(compareResult.summary ?? {})
                  .map(([key, value]) => `${CHANGE_LABELS[key] || key} ${value}`)
                  .join(' · ') || t('assetNoDifference')}
              </p>
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead><tr><th>{t('colChange')}</th><th>Item ID</th><th>Type ID</th><th>{t('assetQtyBefore')}</th><th>{t('assetQtyAfter')}</th><th>{t('assetLocationBefore')}</th><th>{t('assetLocationAfter')}</th><th>{t('colSource')}</th></tr></thead>
                  <tbody>
                    {(compareResult.changes ?? []).map((row: any) => (
                      <tr key={row.changeId}>
                        <td>{row.changeLabelZh}</td>
                        <td>{row.itemId}</td>
                        <td>{row.typeId}</td>
                        <td>{row.prevQuantity ?? 'N/A'}</td>
                        <td>{row.newQuantity ?? 'N/A'}</td>
                        <td>{row.prevLocationId ?? 'N/A'}</td>
                        <td>{row.newLocationId ?? 'N/A'}</td>
                        <td>{row.sourceClass} · {row.confidence}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}

          <h2>{t('assetCharacterTotalsChanges')}</h2>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>{t('colSnapshot')}</th><th>{t('profileFinish')}</th><th>{t('assetItemRow')}</th><th>{t('assetDeltaItems')}</th><th>{t('assetKinds')}</th><th>{t('colLocation')}</th><th>{t('colTotalQuantity')}</th><th>{t('assetDeltaQuantity')}</th></tr></thead>
              <tbody>
                {totalsHistory.map((row) => (
                  <tr key={row.snapshot_id}>
                    <td>{row.snapshot_id}</td>
                    <td>{dateTime(row.completed_at)}</td>
                    <td>{row.total_items}</td>
                    <td>{row.deltaItems ?? 'N/A'}</td>
                    <td>{row.total_unique_types}</td>
                    <td>{row.total_locations}</td>
                    <td>{row.total_quantity}</td>
                    <td>{row.deltaQuantity ?? 'N/A'}</td>
                  </tr>
                ))}
                {!totalsHistory.length ? <tr><td colSpan={8}>{t('assetNoFullSnapshot')}</td></tr> : null}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === 'valuation' ? (
        <>
          <div className="toolbar">
            <button type="button" disabled={busy || characterId === null} onClick={() => void runValuation()}>{t('assetRunLatestValuation')}</button>
            <span>
              {t('assetFeeModelLabel')}{valuations?.latestTotals?.feeModelVersion || t('assetNotRun')} ·
              {' '}{t('assetMarketSnapshotLabel')}{dateTime(valuations?.latestTotals?.marketSnapshotAt)} ·
              {' '}{t('assetAssetSnapshotLabel')}{valuations?.latestTotals?.snapshotId || 'N/A'} ·
              {' '}{t('assetFeeAssumptionsLabel')}{(valuations?.latestTotals?.feeAssumptions as any)?.note || t('assetDefaultAssumptions')}
            </span>
          </div>
          {selectedCharacter?.valuationFreshness?.status === 'STALE' ? (
            <div className="support-note support-note--warn" role="status">
              <strong>{t('assetValuationNotLatest')}</strong>{selectedCharacter.valuationFreshness.message} {t('assetValuationHint')}
            </div>
          ) : null}
          <div className="metric-grid">
            <div className="metric-card"><span>{t('assetMarketReference')}</span><strong>{num(valuations?.latestTotals?.marketReferenceValue, 2)}</strong></div>
            <div className="metric-card"><span>{t('assetBidLiquidation')}</span><strong>{num(valuations?.latestTotals?.bidLiquidationNet, 2)}</strong></div>
            <div className="metric-card"><span>{t('assetAskResetCost')}</span><strong>{num(valuations?.latestTotals?.askReplacementGross, 2)}</strong></div>
            <div className="metric-card"><span>{t('assetHistoricalCost')}</span><strong>UNKNOWN</strong></div>
            <div className="metric-card"><span>{t('assetValuationCoverage')}</span><strong>{valuationCoverage === null ? 'N/A' : `${valuationCoverage.toFixed(2)}%`}</strong></div>
            <div className="metric-card"><span>{t('assetUnknownValuedItems')}</span><strong>{num(unknownValuation, 0)}</strong></div>
            <div className="metric-card"><span>{t('assetShallowDepthItems')}</span><strong>{num(depthShortfall, 0)}</strong></div>
            <div className="metric-card"><span>{t('assetValuedItemTotal')}</span><strong>{num(valuationRows.length, 0)}</strong></div>
          </div>
          <p>{t('assetFourBasesNote')}</p>

          <h2>{t('assetValuationRuns')}</h2>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>{t('assetValuationId')}</th><th>{t('marketLocation')}</th><th>{t('profileStatus')}</th><th>{t('born')}</th><th>{t('assetValuated')}</th><th>{t('supportCostUnknownShort')}</th><th>{t('assetFeeVersion')}</th></tr></thead>
              <tbody>
                {(valuations?.runs ?? []).map((row: any) => (
                  <tr key={row.valuation_id}>
                    <td>{row.valuation_id}</td>
                    <td>{row.hub_location_id} / {row.hub_region_id}</td>
                    <td>{row.status}</td>
                    <td>{dateTime(row.created_at)}</td>
                    <td>{row.items_valued}</td>
                    <td>{row.items_unknown}</td>
                    <td>{row.fee_model_version}</td>
                  </tr>
                ))}
                {!valuations?.runs?.length ? <tr><td colSpan={7}>{t('assetNoValuationRuns')}</td></tr> : null}
              </tbody>
            </table>
          </div>

          <h2>{t('assetLatestValuationDetail')}</h2>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>{t('marketWatchlistItem')}</th><th>{t('marketQuantity')}</th><th>{t('assetMarketRefShort')}</th><th>{t('assetBidGross')}</th><th>{t('assetBidNet')}</th><th>{t('assetSellableUnsold')}</th><th>{t('assetAskReset')}</th><th>{t('profileStatus')}</th></tr></thead>
              <tbody>
                {valuationRows.map((row: any) => (
                  <tr key={row.itemId}>
                    <td>{row.typeId}<br /><small>Item {row.itemId}</small></td>
                    <td>{row.quantity}</td>
                    <td>{num(row.marketReferenceValue, 2)}</td>
                    <td>{num(row.bidLiquidationGross, 2)}</td>
                    <td>{num(row.bidLiquidationNet, 2)}</td>
                    <td>{row.fillableQuantity ?? 'N/A'} / {row.unfillableQuantity ?? 'N/A'}</td>
                    <td>{num(row.askReplacementGross, 2)}</td>
                    <td>{row.statuses.join(' / ')}</td>
                  </tr>
                ))}
                {!valuationRows.length ? <tr><td colSpan={8}>{t('assetNoRunDetail')}</td></tr> : null}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === 'opportunities' ? (
        <>
          <div className="toolbar">
            <button type="button" disabled={busy || characterId === null} onClick={() => void recomputeMatches()}>
              {t('assetRecomputeMatches')}
            </button>
            <span>{t('assetMatchTotalLine', { count: String(matches?.total ?? 0) })}</span>
          </div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('colOpportunity')}</th><th>{t('assetInventorySupport')}</th><th>{t('assetHeldAvailableDemand')}</th><th>{t('colLocation')}</th>
                  <th>{t('assetTransport')}</th><th>{t('assetNetAfterFees')}</th><th>{t('assetComprehensiveProfit')}</th><th>{t('assetDataQuality')}</th>
                </tr>
              </thead>
              <tbody>
                {(matches?.rows ?? []).map((row) => {
                  const reservation = row.locations.find((item) => 'reservation' in item) as any;
                  const quality = row.locations.find((item) => 'dataQuality' in item) as any;
                  const locationRows = row.locations.filter((item) => 'terminalLocationId' in item) as any[];
                  return (
                    <tr key={row.opportunity_id}>
                      <td>
                        {row.type_name || row.type_id}<br />
                        <small>{row.strategy === 'station_arbitrage' ? t('assetStationArbitrage') : t('assetCrossTradeHub')} · {row.state}</small><br />
                        <small>{row.buy_location_name} → {row.sell_location_name}</small>
                      </td>
                      <td>{row.supportClassZh}<br /><small>{row.support_class}</small></td>
                      <td>{row.held_quantity} / {row.accessible_quantity} / {row.required_quantity}</td>
                      <td>
                        {locationRows.map((item) => (
                          <div key={String(item.terminalLocationId)}>
                            {item.locationName || t('assetLocationLabel', { value: String(item.terminalLocationId) })} · {item.quantity} · {item.resolutionStatus}
                            {item.atBuyHub ? ' · BUY HUB' : ''}
                          </div>
                        ))}
                        {!locationRows.length ? t('assetNoLocationDetail') : ''}
                      </td>
                      <td>{row.needs_transport ? t('assetNeedsTransportUnknown') : t('assetNotNeeded')}</td>
                      <td>{num(row.fee_net_profit, 2)}</td>
                      <td>{row.comprehensive_net_profit == null ? row.comprehensive_status : num(row.comprehensive_net_profit, 2)}</td>
                      <td>
                        {t('assetSnapshotLabel', { value: String(quality?.dataQuality?.snapshotId ?? 'UNKNOWN') })}<br />
                        {t('assetUnknownLocationQty', { value: String(quality?.dataQuality?.unknownLocationQuantity ?? 'N/A') })}<br />
                        {t('assetReservedLine', { value: String(reservation?.reservation?.reservedByEarlierOpportunities ?? 0) })} ·
                        {' '}{t('assetAllocatedLine', { value: String(reservation?.reservation?.allocatedToThisOpportunity ?? 0) })}
                      </td>
                    </tr>
                  );
                })}
                {!matches?.rows.length ? <tr><td colSpan={8}>{t('assetNoActiveMatches')}</td></tr> : null}
              </tbody>
            </table>
          </div>
          <p>{t('assetCrossTransportNote')}</p>
        </>
      ) : null}
    </section>
  );
}
