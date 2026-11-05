import { useCallback, useEffect, useState } from 'react';
import { webApi } from '../api';
import { ChartIcon, MenuIcon } from '../icons';
import { P93AccountingPanel } from './P93AccountingPanel';
import { LocaleSwitch, useI18n, type TranslationKey } from '../i18n';
import { formatP93Number, freshnessPresentation, type P93Freshness } from '../p93-freshness';

export type P9Tab = 'overview' | 'accounting' | 'opportunities' | 'plans' | 'assets' | 'inventory' | 'trades' | 'performance' | 'risk' | 'settings';

export const P9_TAB_LABELS: Partial<Record<P9Tab, TranslationKey>> = {
  overview: 'p93TabOverview',
  accounting: 'p9RealLedger',
  opportunities: 'paperTabOpportunities',
  plans: 'p9Plans',
  settings: 'p9SystemSettings',
};

type P9Performance = Record<string, unknown> & {
  freshness?: P93Freshness | null;
  realizedNetPnl?: number | null;
  unrealizedPnl?: number | null;
  feesPaid?: number | null;
  unknownCostMoveCount?: number | null;
};

type P9Overview = {
  portfolio: {
    wallet: { balance: number | null; syncedAt: string | null };
    funding: Record<string, number | string | null>;
    inventory: Record<string, number>;
    performance: P9Performance;
    opportunities: Record<string, number>;
    sync: Array<{ dataset: string; status: string; syncedAt: string | null; expiresAt: string | null; error: string | null }>;
    dataFreshness: Record<string, string>;
  };
  trades: Record<string, number | Record<string, unknown> | null>;
  settings: P9Settings;
  marketScan: Record<string, unknown> | null;
  riskSummary: Array<{ risk_level: string; state: string; count: number }>;
  separation: Record<string, boolean>;
};

type P9Settings = {
  hubs: Array<{ locationId: number; regionId: number; name: string; enabled?: boolean }>;
  strategies: string[];
  minNetProfit: number;
  minRoiPct: number;
  maxCapital: number;
  maxMarketAgeMinutes: number;
  maxResults: number;
  autoScanEnabled: boolean;
  autoScanIntervalMinutes: number;
};

type P9Opportunity = {
  opportunityId: string;
  strategy: string;
  typeId: number;
  typeNameEn: string;
  typeNameZh?: string;
  buyLocationName: string;
  sellLocationName: string;
  buyPrice: number;
  sellPrice: number;
  suggestedQuantity: number;
  executableQuantity: number;
  purchaseAmount: number;
  salesRevenue: number;
  brokerFees: number;
  salesTax: number;
  otherFees: number;
  theoreticalGrossProfit: number;
  executableGrossProfit: number;
  feeNetProfit: number;
  comprehensiveNetProfit: number | null;
  comprehensiveStatus: string;
  capitalRequired: number;
  roiPct: number;
  logisticsCost: number | null;
  liquidity: string;
  riskLevel: string;
  riskFlags: string[];
  buySnapshotAt: string | null;
  sellSnapshotAt: string | null;
  buySnapshotAgeMinutes: number | null;
  sellSnapshotAgeMinutes: number | null;
  dataComplete: boolean;
  dataFresh: boolean;
  spreadDetected: boolean;
  marketExecutable: boolean;
  profitAfterKnownFees: boolean;
  logisticsKnown: boolean;
  overallProfitKnown: boolean;
  tradePlanComplete: boolean;
  dataSource: string;
  calculationVersion: string;
  buySnapshotId: string;
  sellSnapshotId: string;
  state: string;
  updatedAt: string;
  expiresAt: string;
};

type P9Plan = Record<string, unknown> & { planId: string; status: string; opportunityId: string; quantity: number; validUntil: string };
type P9Trade = Record<string, unknown> & { tradeId: string; direction: string; typeId: number; quantity: number; price: number; fee: number; pnlStatus: string; realizedPnl: number | null; source: string; tradeTime: string };
type P9Lot = Record<string, unknown> & { lotId: string; typeId: number; quantity: number; costPerUnit: number | null; costStatus: string; locationId: number };
type P9Risk = { flags: Array<{ flag: string; count: number }>; stale: Array<{ state: string; count: number }>; unknownInventoryLots: number; syncErrors: Array<Record<string, unknown>>; controls: Record<string, unknown> };
type MarketRegionStatus = { region_id: number; fetched_at: string | null; age_minutes: number | null; stale: boolean; last_error: string | null };
type MarketStatus = { loaded: boolean; status: string; snapshot_time: string | null; age_minutes: number | null; stale: boolean; rows_loaded: number | null; last_error: string | null; regions: MarketRegionStatus[] };
type P9OpportunityDetail = { opportunity: P9Opportunity; originalSnapshot: Record<string, any>; plan: Record<string, any> | null; executionDisabled: boolean };

const num = formatP93Number;
const pct = (value: unknown): string => typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(2)}%` : 'N/A';
// All P9 timestamps are UTC (ISO strings or SQLite datetime('now')); render
// them in the viewer's local timezone instead of showing raw UTC digits.
const dateTime = (value: unknown): string => {
  if (typeof value !== 'string' || !value) return 'N/A';
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const withZone = /Z|[+-]\d{2}:\d{2}$/.test(normalized) ? normalized : `${normalized}Z`;
  const parsed = new Date(withZone);
  if (Number.isNaN(parsed.getTime())) return value.replace('T', ' ').slice(0, 19);
  return parsed.toLocaleString('zh-CN', { hour12: false });
};
const matchLevels = (levels: Array<{ price: number; volumeRemain: number }>, quantity: number, descending: boolean) => {
  const sorted = [...levels].sort((a, b) => descending ? b.price - a.price : a.price - b.price);
  let remaining = quantity;
  let cumulative = 0;
  const rows: Array<{ price: number; volumeRemain: number; take: number; cumulative: number }> = [];
  for (const level of sorted) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, level.volumeRemain);
    if (take <= 0) continue;
    remaining -= take;
    cumulative += take;
    rows.push({ price: level.price, volumeRemain: level.volumeRemain, take, cumulative });
  }
  return rows;
};

type Props = { onMenu: () => void; csrfToken: string };

export function P9TradingScreen({ onMenu, csrfToken }: Props) {
  const { t } = useI18n();
  const [tab, setTab] = useState<P9Tab>('accounting');
  const [overview, setOverview] = useState<P9Overview | null>(null);
  const [settings, setSettings] = useState<P9Settings | null>(null);
  const [opportunities, setOpportunities] = useState<P9Opportunity[]>([]);
  const [plans, setPlans] = useState<P9Plan[]>([]);
  const [trades, setTrades] = useState<P9Trade[]>([]);
  const [inventory, setInventory] = useState<{ lots: P9Lot[]; rawAssets: Array<Record<string, unknown>> } | null>(null);
  const [risk, setRisk] = useState<P9Risk | null>(null);
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [marketStatus, setMarketStatus] = useState<MarketStatus | null>(null);
  const [detail, setDetail] = useState<P9OpportunityDetail | null>(null);
  const [scanTypeIds, setScanTypeIds] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filters, setFilters] = useState({ state: '', strategy: '', q: '', sort: 'net' });
  const [tradeForm, setTradeForm] = useState({
    clientKey: `manual-${Date.now()}`,
    direction: 'buy',
    typeId: '34',
    locationId: '60003760',
    quantity: '1',
    price: '',
    fee: '0',
    tradeTime: new Date().toISOString().slice(0, 16),
    notes: '',
  });
  const [lotForm, setLotForm] = useState({
    itemId: '',
    typeId: '34',
    locationId: '60003760',
    quantity: '1',
    costPerUnit: '',
    acquiredAt: new Date().toISOString().slice(0, 16),
    notes: '',
  });

  const load = useCallback(async (activeTab: P9Tab = tab) => {
    setBusy(true);
    setError(null);
    try {
      const requests: Array<Promise<unknown>> = [webApi.p9.overview(), webApi.market.status()];
      if (activeTab === 'opportunities') requests.push(webApi.p9.opportunities({ ...filters, limit: 200 }));
      if (activeTab === 'plans') requests.push(webApi.p9.plans());
      if (activeTab === 'trades' || activeTab === 'performance') requests.push(webApi.p9.realTrades({ limit: 300 }));
      if (activeTab === 'inventory' || activeTab === 'assets') requests.push(webApi.p9.inventory());
      if (activeTab === 'risk') requests.push(webApi.p9.risk());
      if (activeTab === 'settings') requests.push(webApi.p9.settings());
      const results = await Promise.all(requests);
      let cursor = 2;
      setOverview(results[0] as P9Overview);
      setMarketStatus(((results[1] as { snapshot?: MarketStatus })?.snapshot || null));
      if (activeTab === 'opportunities') setOpportunities(((results[cursor++] as any)?.rows || []) as P9Opportunity[]);
      if (activeTab === 'plans') setPlans(((results[cursor++] as any)?.plans || []) as P9Plan[]);
      if (activeTab === 'trades' || activeTab === 'performance') setTrades(((results[cursor++] as any)?.trades || []) as P9Trade[]);
      if (activeTab === 'inventory' || activeTab === 'assets') setInventory(results[cursor++] as never);
      if (activeTab === 'risk') setRisk(results[cursor++] as never);
      if (activeTab === 'settings') {
        const payload = results[cursor++] as { settings: P9Settings };
        setSettings(payload.settings);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('p9LoadFailed'));
    } finally {
      setBusy(false);
    }
  }, [tab, filters]);

  useEffect(() => { void load(tab); }, [tab, load]);
  const runAction = useCallback(async (action: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      if (success) setNotice(success);
      await load(tab);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('assetActionFailed'));
    } finally {
      setBusy(false);
    }
  }, [load, tab]);

  const scan = () => {
    const typeIds = [...new Set(scanTypeIds.split(/[\s,，]+/).map((value) => Number(value)))]
      .filter((value) => Number.isSafeInteger(value) && value > 0)
      .slice(0, 500);
    return runAction(() => webApi.p9.scan(csrfToken, typeIds), typeIds.length > 0
      ? t('p9ScanTypedIds', { value: String(typeIds.length) })
      : t('p9ScanDone'));
  };
  const openDetail = (opportunityId: string) => runAction(async () => {
    const payload = await webApi.p9.opportunity(opportunityId) as P9OpportunityDetail;
    setDetail(payload);
  }, t('p9DetailLoaded'));
  const analyze = (mode: 'opportunity' | 'daily', opportunityId?: string) => runAction(async () => {
    const payload = await webApi.p9.analyze({ mode, opportunityIds: opportunityId ? [opportunityId] : [] }, csrfToken) as { analysis: string };
    setAnalysis(payload.analysis);
  }, t('p9AiAnalysisDone'));
  const createPlan = (opportunityId: string) => runAction(() => webApi.p9.createPlan(opportunityId, csrfToken), t('p9PlanGenerated'));
  const archiveOpportunity = (opportunityId: string) => runAction(() => webApi.p9.transitionOpportunity(opportunityId, 'ARCHIVED', csrfToken), t('p9OpportunityArchived'));
  const confirmPlan = (planId: string) => runAction(() => webApi.p9.transitionPlan(planId, 'USER_CONFIRMED', csrfToken), t('p9PlanConfirmed'));
  const syncEsiTrades = () => runAction(() => webApi.p9.syncEsiTrades(csrfToken), t('p9EsiTradesSynced'));
  const rebuildLedger = () => runAction(() => webApi.p9.rebuildLedger(csrfToken), t('p9InventoryRecalc'));
  const syncAssets = () => runAction(() => webApi.profile.sync(['wallet', 'assets', 'orders'], csrfToken), t('p9WalletSynced'));

  const saveSettings = async () => {
    if (!settings) return;
    await runAction(() => webApi.p9.saveSettings(settings, csrfToken), t('p9ScanSettingsSaved'));
  };

  const recordTrade = async () => {
    const tradeTime = new Date(tradeForm.tradeTime).toISOString();
    await runAction(() => webApi.p9.recordTrade({
      clientKey: tradeForm.clientKey,
      direction: tradeForm.direction,
      typeId: Number(tradeForm.typeId),
      locationId: Number(tradeForm.locationId),
      quantity: Number(tradeForm.quantity),
      price: Number(tradeForm.price),
      fee: Number(tradeForm.fee),
      tradeTime,
      notes: tradeForm.notes || undefined,
      confirmed: true,
    }, csrfToken), t('p9TradeRecorded'));
    setTradeForm((current) => ({ ...current, clientKey: `manual-${Date.now()}` }));
  };

  const createLot = async () => {
    await runAction(() => webApi.p9.createLot({
      itemId: lotForm.itemId ? Number(lotForm.itemId) : null,
      typeId: Number(lotForm.typeId),
      locationId: Number(lotForm.locationId),
      quantity: Number(lotForm.quantity),
      costPerUnit: lotForm.costPerUnit === '' ? null : Number(lotForm.costPerUnit),
      acquiredAt: new Date(lotForm.acquiredAt).toISOString(),
      notes: lotForm.notes || undefined,
    }, csrfToken), lotForm.costPerUnit === '' ? t('p9StockRecordedUnknown') : t('p9CostConfirmed'));
  };

  const realizedTrades = trades.filter((row) => row.direction === 'sell' && row.pnlStatus === 'CALCULATED');
  const unknownTrades = trades.filter((row) => row.pnlStatus === 'UNKNOWN_COST');
  const realizedFromRows = realizedTrades.reduce((sum, row) => sum + Number(row.realizedPnl || 0), 0);

  if (!overview) {
    return error
      ? <div className="screen-error" role="alert">{error}</div>
      : <div className="app-loading" aria-label={t('p9Loading')}><span /><span /><span /></div>;
  }
  const fifoFreshness = freshnessPresentation(overview.portfolio.performance.freshness, t);
  const fifoFreshnessStatus = fifoFreshness.status;
  const fifoFreshnessWarning = fifoFreshness.warning;
  return (
    <section className="market-screen">
      <header className="market-screen__topbar">
        <button className="icon-button" type="button" onClick={onMenu} aria-label={t('openMenu')}><MenuIcon size={20} /></button>
        <h1><ChartIcon size={18} /> {t('p9Title')}</h1>
        <span className="status-pill">{t('p9ModePill')}</span>
        <LocaleSwitch />
        <button className="button button--secondary" type="button" disabled={busy} onClick={() => void scan()}>{t('p9ScanNow')}</button>
        <button className="button button--secondary" type="button" disabled={busy} onClick={() => void load(tab)}>{t('refresh')}</button>
      </header>

      <nav className="market-tabs" aria-label={t('p9ViewNav')}>
        {(Object.keys(P9_TAB_LABELS) as P9Tab[]).map((key) => (
          <button key={key} type="button" className={tab === key ? 'market-tab market-tab--active' : 'market-tab'} onClick={() => setTab(key)}>
            {t(P9_TAB_LABELS[key]!)}
          </button>
        ))}
      </nav>

      {error ? <div className="screen-error" role="alert">{error}</div> : null}
      {notice ? <div className="screen-success" role="status">{notice}</div> : null}
      {busy ? <p>{t('assetProcessing')}</p> : null}

      {tab === 'accounting' ? <P93AccountingPanel csrfToken={csrfToken} /> : null}

      {tab === 'overview' ? (
        <>
          <div className="metric-grid">
            <div className="metric-card"><span>{t('p9CurrentIsk')}</span><strong>{num(overview.portfolio.wallet.balance, 0)}</strong></div>
            <div className="metric-card"><span>{t('p9AvailableFunds')}</span><strong>{num(overview.portfolio.funding.availableIsk, 0)}</strong></div>
            <div className="metric-card"><span>{t('p9OrdersTied')}</span><strong>{num(overview.portfolio.funding.openOrderEscrow, 0)}</strong></div>
            <div className="metric-card"><span>{t('p9KnownStockCost')}</span><strong>{num(overview.portfolio.funding.knownInventoryCost, 0)}</strong></div>
            <div className="metric-card"><span>{t('p9ActionableOpps')}</span><strong>{num(overview.portfolio.opportunities.actionable, 0)}</strong></div>
            <div className="metric-card"><span>{t('p9Watching')}</span><strong>{num(overview.portfolio.opportunities.watching, 0)}</strong></div>
            <div className="metric-card"><span>{t('p9StaleExpired')}</span><strong>{num(overview.portfolio.opportunities.staleOrExpired, 0)}</strong></div>
            <div className="metric-card"><span>{t('p9RealTrades')}</span><strong>{num(overview.trades.count, 0)}</strong></div>
            <div className="metric-card"><span>{t('p9FifoStatus')}</span><strong>{fifoFreshnessStatus}</strong></div>
            <div className="metric-card"><span>{t('p9RealizedCertain')}</span><strong>{num(overview.portfolio.performance.realizedNetPnl, 2)}</strong></div>
            <div className="metric-card"><span>{t('colKnownPartial')}</span><strong>{num(overview.portfolio.performance.knownRealizedPnl, 2)}</strong></div>
            <div className="metric-card"><span>{t('paperUnrealizedPnl')}</span><strong>{num(overview.portfolio.performance.unrealizedPnl, 2)}</strong></div>
            <div className="metric-card"><span>{t('p9UnknownCostStock')}</span><strong>{num(overview.portfolio.inventory.unknownLotCount, 0)}</strong></div>
            <div className="metric-card"><span>{t('p9MarketDataStatus')}</span><strong>{marketStatus ? (marketStatus.stale ? 'STALE' : marketStatus.status.toUpperCase()) : 'LOADING'}</strong></div>
            <div className="metric-card"><span>{t('p9MarketSnapshotTime')}</span><strong>{dateTime(marketStatus?.snapshot_time)}</strong></div>
            <div className="metric-card"><span>{t('p9MarketDataRows')}</span><strong>{num(marketStatus?.rows_loaded, 0)}</strong></div>
            <div className="metric-card"><span>{t('p9MarketDataStale')}</span><strong>{marketStatus ? (marketStatus.stale ? t('p9Yes') : t('p9No')) : 'N/A'}</strong></div>
          </div>
          {fifoFreshnessWarning ? <p className="screen-warning" role="status">{fifoFreshnessWarning}</p> : null}
          <h2>{t('p9DataSyncStatus')}</h2>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>{t('profileDataset')}</th><th>{t('profileStatus')}</th><th>{t('profileSyncedAt')}</th><th>{t('p9Validity')}</th><th>{t('profileError')}</th></tr></thead>
              <tbody>
                {overview.portfolio.sync.map((row) => (
                  <tr key={row.dataset}><td>{row.dataset}</td><td>{row.status}</td><td>{dateTime(row.syncedAt)}</td><td>{dateTime(row.expiresAt)}</td><td>{row.error || t('paperNoRiskFlags')}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <h2>{t('p9MarketHubStatus')}</h2>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>{t('p9TradeHub')}</th><th>{t('p9RegionId')}</th><th>{t('p9LastCollected')}</th><th>{t('p9AgeMinutes')}</th><th>{t('profileStatus')}</th><th>{t('profileError')}</th></tr></thead>
              <tbody>
                {overview.settings.hubs.filter((hub) => hub.enabled !== false).map((hub) => {
                  const region = marketStatus?.regions.find((row) => row.region_id === hub.regionId);
                  return (
                    <tr key={hub.locationId}>
                      <td>{hub.name}</td>
                      <td>{hub.regionId}</td>
                      <td>{dateTime(region?.fetched_at)}</td>
                      <td>{region?.age_minutes == null ? 'N/A' : region.age_minutes}</td>
                      <td>{region ? (region.stale ? 'STALE' : 'FRESH') : 'NO_DATA'}</td>
                      <td>{region?.last_error || marketStatus?.last_error || t('paperNoRiskFlags')}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <h2>{t('p9LastScan')}</h2>
          <p>{overview.marketScan ? `${String(overview.marketScan.status)} · ${dateTime(overview.marketScan.started_at)} · ${String(overview.marketScan.summary_json || '')}` : t('p9NeverScanned')}</p>
        </>
      ) : null}

      {tab === 'opportunities' ? (
        <>
          <div className="toolbar">
            <input value={filters.q} onChange={(event) => setFilters((current) => ({ ...current, q: event.target.value }))} placeholder={t('p9SearchPlaceholder')} />
            <select value={filters.state} onChange={(event) => setFilters((current) => ({ ...current, state: event.target.value }))}>
              <option value="">{t('p9AllStatuses')}</option><option>ACTIONABLE</option><option>WATCHING</option><option>STALE</option><option>EXPIRED</option><option>REJECTED</option><option>ARCHIVED</option>
            </select>
            <select value={filters.strategy} onChange={(event) => setFilters((current) => ({ ...current, strategy: event.target.value }))}>
              <option value="">{t('p9AllStrategies')}</option><option value="station_arbitrage">{t('assetStationArbitrage')}</option><option value="regional_hauling">{t('p9CrossHubArbitrage')}</option>
            </select>
            <select value={filters.sort} onChange={(event) => setFilters((current) => ({ ...current, sort: event.target.value }))}>
              <option value="net">{t('p9NetProfit')}</option><option value="roi">{t('p9Roi')}</option><option value="capital">{t('p9RequiredCapital')}</option><option value="liquidity">{t('p9Liquidity')}</option><option value="risk">{t('colRisk')}</option>
            </select>
            <input value={scanTypeIds} onChange={(event) => setScanTypeIds(event.target.value)} placeholder={t('p9TypeIdsHint')} />
            <button type="button" disabled={busy} onClick={() => void scan()}>{t('p9ScanByType')}</button>
          </div>
          {opportunities.length === 0 ? <p className="screen-empty">{t('p9NoOpportunities')}</p> : null}
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>{t('p9OppItem')}</th><th>{t('p9StrategyRoute')}</th><th>{t('p9SuggestedQty')}</th><th>{t('p9FourLayerProfit')}</th><th>{t('p9CapitalRoi')}</th><th>{t('p9RiskData')}</th><th>{t('colAction')}</th></tr></thead>
              <tbody>
                {opportunities.map((row) => (
                  <tr key={row.opportunityId}>
                    <td><strong>{row.typeNameZh || row.typeNameEn}</strong><br /><small>{row.typeId} · {row.state === 'WATCHING' ? t('p9WatchingTag') : row.state === 'ACTIONABLE' ? t('p9ActionableTag') : row.state}</small></td>
                    <td>{row.strategy === 'station_arbitrage' ? t('assetStationArbitrage') : t('assetCrossTradeHub')}<br /><small>{row.buyLocationName}<br />→ {row.sellLocationName}</small></td>
                    <td>{row.suggestedQuantity}<br /><small>{t('p9ExecutableQty', { value: String(row.executableQuantity) })}</small></td>
                    <td>
                      {t('p9Theoretical', { value: num(row.theoreticalGrossProfit, 0) })}<br />
                      {t('p9ExecutableQty', { value: num(row.executableGrossProfit, 0) })}<br />
                      {t('p9FeeNet', { value: num(row.feeNetProfit, 0) })}<br />
                      {t('p9Comprehensive', { value: row.comprehensiveNetProfit == null ? row.comprehensiveStatus : num(row.comprehensiveNetProfit, 0) })}
                    </td>
                    <td>{num(row.capitalRequired, 0)}<br />{pct(row.roiPct)}</td>
                    <td>{row.riskLevel} · {t('p9LiquidityLabel', { value: String(row.liquidity) })}<br /><small>{t('p9SpreadLabel')}{row.spreadDetected ? t('p9Detected') : t('paperNoRiskFlags')} · {t('p9OrderBookLabel')}{row.marketExecutable ? t('p9Executable') : t('p9NotExecutable')} · {t('p9ProfitAfterKnownLabel')}{row.profitAfterKnownFees ? t('p9Positive') : t('p9NotPositive')} · {t('p9LogisticsLabel')}{row.logisticsKnown ? t('p9Known') : 'UNKNOWN'} · {t('p9CompleteCondLabel')}{row.tradePlanComplete ? t('p9Satisfied') : t('p9Unsatisfied')}</small><br /><small>{row.riskFlags.join(t('p9ListSep')) || t('p9NoExtraFlags')}</small><br /><small>{t('p9UpdatedLabel')}{dateTime(row.updatedAt)}<br />{t('p9ExpiresLabel')}{dateTime(row.expiresAt)}</small></td>
                    <td>
                      <button type="button" disabled={busy} onClick={() => void openDetail(row.opportunityId)}>{t('p93Detail')}</button>
                      <button type="button" disabled={busy} onClick={() => void createPlan(row.opportunityId)}>{t('p9GeneratePlan')}</button>
                      <button type="button" disabled={busy} onClick={() => void analyze('opportunity', row.opportunityId)}>{t('p9AiExplain')}</button>
                      <button type="button" disabled={busy} onClick={() => void archiveOpportunity(row.opportunityId)}>{t('p9Archive')}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {analysis ? <><h2>{t('p9AiResearchNote')}</h2><pre>{analysis}</pre></> : null}
        </>
      ) : null}

      {tab === 'plans' ? (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th>{t('p9Plan')}</th><th>{t('p9StatusValidity')}</th><th>{t('p9ItemQty')}</th><th>{t('p9EstCostRevenue')}</th><th>{t('p9EstProfitAfterFees')}</th><th>{t('p9TransportCost')}</th><th>{t('assetComprehensiveProfit')}</th><th>{t('colAction')}</th></tr></thead>
            <tbody>
              {plans.map((row) => (
                <tr key={row.planId}>
                  <td>{row.planId}<br /><small>{row.opportunityId}</small></td>
                  <td>{row.status}<br /><small>{dateTime(row.validUntil)}</small></td>
                  <td>{String(row.typeId)} × {row.quantity}</td>
                  <td>{num(row.estimatedBuyCost, 0)}<br />{num(row.estimatedSellRevenue, 0)}</td>
                  <td>{num(row.estimatedFeeNetProfit, 0)}</td>
                  <td>{String(row.strategy) === 'regional_hauling' ? 'UNKNOWN' : '0'}</td>
                  <td>{row.comprehensiveStatus === 'UNKNOWN' || row.estimatedComprehensiveProfit == null ? 'UNKNOWN' : num(row.estimatedComprehensiveProfit, 0)}</td>
                  <td>{row.status === 'PLANNED' ? <button type="button" disabled={busy} onClick={() => void confirmPlan(row.planId)}>{t('p9ManualConfirm')}</button> : <small>{t('p9AwaitingFill')}</small>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {plans.length === 0 ? <p className="screen-empty">{t('p9NoPlans')}</p> : null}
        </div>
      ) : null}
      {tab === 'assets' ? (
        <>
          <div className="metric-grid">
            <div className="metric-card"><span>{t('p9WalletBalance')}</span><strong>{num(overview.portfolio.wallet.balance, 0)}</strong></div>
            <div className="metric-card"><span>{t('p9OrdersTied')}</span><strong>{num(overview.portfolio.funding.openOrderEscrow, 0)}</strong></div>
            <div className="metric-card"><span>{t('p9RawAssetRows')}</span><strong>{num(overview.portfolio.inventory.rawAssetCount, 0)}</strong></div>
            <div className="metric-card"><span>{t('p9AssetStatus')}</span><strong>{overview.portfolio.dataFreshness.assets}</strong></div>
          </div>
          <p>{t('p9UnknownFundsLead')}<strong>UNKNOWN</strong>{t('p9UnknownFundsTail')}</p>
          <div className="toolbar"><button type="button" disabled={busy} onClick={() => void syncAssets()}>{t('p9SyncWalletAssets')}</button><button type="button" disabled={busy} onClick={() => void rebuildLedger()}>{t('p9RecalcStockPnl')}</button></div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Item</th><th>{t('p9Item')}</th><th>{t('marketLocation')}</th><th>{t('marketQuantity')}</th><th>{t('p9ConfirmedCost')}</th><th>{t('p9LevelExitValue')}</th><th>{t('paperUnrealizedPnl')}</th></tr></thead>
              <tbody>
                {(inventory?.rawAssets || []).map((row) => (
                  <tr key={String(row.itemId)}>
                    <td>{String(row.itemId)}</td><td>{String(row.typeName || row.typeId)}</td><td>{String(row.locationId)}</td><td>{String(row.quantity)}</td>
                    <td>{row.confirmedCostPerUnit == null ? 'UNKNOWN' : num(row.confirmedCostPerUnit)}</td>
                    <td>{num(row.executableExitNet, 2)}{row.depthLimited ? t('p9DepthLimited') : ''}</td>
                    <td>{row.unrealizedPnl == null ? 'UNKNOWN' : num(row.unrealizedPnl, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === 'inventory' ? (
        <>
          <h2>{t('p9ConfirmStockCost')}</h2>
          <div className="form-grid">
            <label>{t('p9ItemIdOptional')}<input value={lotForm.itemId} onChange={(event) => setLotForm((v) => ({ ...v, itemId: event.target.value }))} /></label>
            <label>Type ID<input value={lotForm.typeId} onChange={(event) => setLotForm((v) => ({ ...v, typeId: event.target.value }))} /></label>
            <label>{t('colLocationId')}<input value={lotForm.locationId} onChange={(event) => setLotForm((v) => ({ ...v, locationId: event.target.value }))} /></label>
            <label>{t('marketQuantity')}<input value={lotForm.quantity} onChange={(event) => setLotForm((v) => ({ ...v, quantity: event.target.value }))} /></label>
            <label>{t('p9UnitCostHint')}<input value={lotForm.costPerUnit} onChange={(event) => setLotForm((v) => ({ ...v, costPerUnit: event.target.value }))} /></label>
            <label>{t('p9AcquiredAt')}<input type="datetime-local" value={lotForm.acquiredAt} onChange={(event) => setLotForm((v) => ({ ...v, acquiredAt: event.target.value }))} /></label>
            <label>{t('colNote')}<input value={lotForm.notes} onChange={(event) => setLotForm((v) => ({ ...v, notes: event.target.value }))} /></label>
          </div>
          <button type="button" disabled={busy} onClick={() => void createLot()}>{t('p9SaveStockCost')}</button>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Lot</th><th>{t('p9Item')}</th><th>{t('marketLocation')}</th><th>{t('marketQuantity')}</th><th>{t('p9Cost')}</th><th>{t('colSource')}</th><th>{t('p9ExitValuePnl')}</th></tr></thead>
              <tbody>
                {(inventory?.lots || []).map((row) => (
                  <tr key={row.lotId}>
                    <td>{row.lotId}</td><td>{String(row.typeName || row.typeId)}</td><td>{String(row.locationId)}</td><td>{row.quantity}</td>
                    <td>{row.costPerUnit == null ? 'UNKNOWN' : num(row.costPerUnit)}</td><td>{String(row.source)}</td>
                    <td>{num(row.executableExitNet, 2)} / {row.unrealizedPnl == null ? 'UNKNOWN' : num(row.unrealizedPnl, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === 'trades' ? (
        <>
          <div className="toolbar">
            <button type="button" disabled={busy} onClick={() => void syncEsiTrades()}>{t('p9SyncEsiTrades')}</button>
            <button type="button" disabled={busy} onClick={() => void rebuildLedger()}>{t('p9RebuildFifo')}</button>
          </div>
          <h2>{t('p9EnterRealTrade')}</h2>
          <div className="form-grid">
            <label>{t('p9IdempotencyKey')}<input value={tradeForm.clientKey} onChange={(event) => setTradeForm((v) => ({ ...v, clientKey: event.target.value }))} /></label>
            <label>{t('marketAlertSide')}<select value={tradeForm.direction} onChange={(event) => setTradeForm((v) => ({ ...v, direction: event.target.value }))}><option value="buy">{t('marketBuySide')}</option><option value="sell">{t('marketSellSide')}</option></select></label>
            <label>Type ID<input value={tradeForm.typeId} onChange={(event) => setTradeForm((v) => ({ ...v, typeId: event.target.value }))} /></label>
            <label>{t('colLocationId')}<input value={tradeForm.locationId} onChange={(event) => setTradeForm((v) => ({ ...v, locationId: event.target.value }))} /></label>
            <label>{t('marketQuantity')}<input value={tradeForm.quantity} onChange={(event) => setTradeForm((v) => ({ ...v, quantity: event.target.value }))} /></label>
            <label>{t('profileUnitPrice')}<input value={tradeForm.price} onChange={(event) => setTradeForm((v) => ({ ...v, price: event.target.value }))} /></label>
            <label>{t('p9ActualFees')}<input value={tradeForm.fee} onChange={(event) => setTradeForm((v) => ({ ...v, fee: event.target.value }))} /></label>
            <label>{t('p9TradeTime')}<input type="datetime-local" value={tradeForm.tradeTime} onChange={(event) => setTradeForm((v) => ({ ...v, tradeTime: event.target.value }))} /></label>
            <label>{t('colNote')}<input value={tradeForm.notes} onChange={(event) => setTradeForm((v) => ({ ...v, notes: event.target.value }))} /></label>
          </div>
          <button type="button" disabled={busy} onClick={() => void recordTrade()}>{t('p9RecordAndRecalc')}</button>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>{t('p9Trade')}</th><th>{t('p9DirectionSource')}</th><th>{t('p9ItemLocation')}</th><th>{t('p9QtyPriceFees')}</th><th>{t('colTime')}</th><th>{t('p9RealizedPnl')}</th></tr></thead>
              <tbody>
                {trades.map((row) => (
                  <tr key={row.tradeId}>
                    <td>{row.tradeId}<br /><small>{String(row.clientKey)}</small></td>
                    <td>{row.direction} · {row.source}</td>
                    <td>{row.typeId}<br /><small>{String(row.locationId)}</small></td>
                    <td>{row.quantity} × {num(row.price)}<br />{t('p9FeeLabel', { value: num(row.fee) })}</td>
                    <td>{dateTime(row.tradeTime)}</td>
                    <td>{row.pnlStatus === 'UNKNOWN_COST' ? 'UNKNOWN' : num(row.realizedPnl, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === 'performance' ? (
        <>
          <div className="metric-grid">
            <div className="metric-card"><span>{t('p9RealTradeCount')}</span><strong>{num(overview.trades.count, 0)}</strong></div>
            <div className="metric-card"><span>{t('p9BuySell')}</span><strong>{num(overview.trades.buyCount, 0)} / {num(overview.trades.sellCount, 0)}</strong></div>
            <div className="metric-card"><span>{t('p9FifoStatus')}</span><strong>{fifoFreshnessStatus}</strong></div>
            <div className="metric-card"><span>{t('p9RealizedCertain')}</span><strong>{num(overview.portfolio.performance.realizedNetPnl, 2)}</strong></div>
            <div className="metric-card"><span>{t('colKnownPartial')}</span><strong>{num(overview.portfolio.performance.knownRealizedPnl, 2)}</strong></div>
            <div className="metric-card"><span>{t('p9FeesPaid')}</span><strong>{num(overview.portfolio.performance.feesPaid, 2)}</strong></div>
            <div className="metric-card"><span>{t('p93UnknownCostItems')}</span><strong>{num(overview.portfolio.performance.unknownCostMoveCount, 0)}</strong></div>
            <div className="metric-card"><span>{t('p93UnknownCostSells')}</span><strong>{num(overview.portfolio.performance.unknownCostSellCount, 0)}</strong></div>
            <div className="metric-card"><span>{t('p93CertainSells')}</span><strong>{num(overview.portfolio.performance.deterministicSellCount, 0)}</strong></div>
            <div className="metric-card"><span>{t('p9ListConfirmable')}</span><strong>{num(realizedFromRows, 2)}</strong></div>
          </div>
          {fifoFreshnessWarning ? <p className="screen-warning" role="status">{fifoFreshnessWarning}</p> : null}
          <p>{t('p9RealOnlyNote')}</p>
          <p>{t('p9UnknownTradesLine', { count: String(unknownTrades.length) })}</p>
          <button type="button" disabled={busy} onClick={() => void analyze('daily')}>{t('p9DailyAiReport')}</button>
          {analysis ? <pre>{analysis}</pre> : null}
        </>
      ) : null}

      {tab === 'risk' && risk ? (
        <>
          <div className="metric-grid">
            <div className="metric-card"><span>{t('p9UnknownCostStock')}</span><strong>{risk.unknownInventoryLots}</strong></div>
            <div className="metric-card"><span>{t('p9StaleOpps')}</span><strong>{risk.stale.reduce((sum, row) => sum + row.count, 0)}</strong></div>
            <div className="metric-card"><span>{t('p9SyncErrors')}</span><strong>{risk.syncErrors.length}</strong></div>
            <div className="metric-card"><span>{t('p9AutoRealTrading')}</span><strong>DISABLED</strong></div>
          </div>
          <div className="data-table-wrap">
            <table className="data-table"><thead><tr><th>{t('paperRiskFlagsTitle')}</th><th>{t('marketQuantity')}</th></tr></thead><tbody>{risk.flags.map((row) => <tr key={row.flag}><td>{row.flag}</td><td>{row.count}</td></tr>)}</tbody></table>
          </div>
          <h2>{t('p9RiskParams')}</h2>
          <pre>{JSON.stringify(risk.controls, null, 2)}</pre>
          <h2>{t('p9SyncErrors')}</h2>
          <pre>{JSON.stringify(risk.syncErrors, null, 2)}</pre>
        </>
      ) : null}

      {tab === 'settings' && settings ? (
        <>
          <div className="form-grid">
            <label>{t('p9MinNetProfit')}<input type="number" value={settings.minNetProfit} onChange={(event) => setSettings((v) => v ? { ...v, minNetProfit: Number(event.target.value) } : v)} /></label>
            <label>{t('p9MinRoi')}<input type="number" value={settings.minRoiPct} onChange={(event) => setSettings((v) => v ? { ...v, minRoiPct: Number(event.target.value) } : v)} /></label>
            <label>{t('p9MaxCapitalPerTrade')}<input type="number" value={settings.maxCapital} onChange={(event) => setSettings((v) => v ? { ...v, maxCapital: Number(event.target.value) } : v)} /></label>
            <label>{t('p9MaxMarketAge')}<input type="number" value={settings.maxMarketAgeMinutes} onChange={(event) => setSettings((v) => v ? { ...v, maxMarketAgeMinutes: Number(event.target.value) } : v)} /></label>
            <label>{t('p9MaxResults')}<input type="number" value={settings.maxResults} onChange={(event) => setSettings((v) => v ? { ...v, maxResults: Number(event.target.value) } : v)} /></label>
            <label>{t('p9AutoScanInterval')}<input type="number" value={settings.autoScanIntervalMinutes} onChange={(event) => setSettings((v) => v ? { ...v, autoScanIntervalMinutes: Number(event.target.value) } : v)} /></label>
            <label>{t('p9AutoScan')}<input type="checkbox" checked={settings.autoScanEnabled} onChange={(event) => setSettings((v) => v ? { ...v, autoScanEnabled: event.target.checked } : v)} /></label>
          </div>
          <h2>{t('p9HubWhitelist')}</h2>
          {settings.hubs.map((hub, index) => (
            <div className="form-grid" key={`${hub.locationId}-${index}`}>
              <label>{t('colLocationId')}<input type="number" value={hub.locationId} onChange={(event) => setSettings((v) => v ? { ...v, hubs: v.hubs.map((row, i) => i === index ? { ...row, locationId: Number(event.target.value) } : row) } : v)} /></label>
              <label>{t('p9RegionId')}<input type="number" value={hub.regionId} onChange={(event) => setSettings((v) => v ? { ...v, hubs: v.hubs.map((row, i) => i === index ? { ...row, regionId: Number(event.target.value) } : row) } : v)} /></label>
              <label>{t('p9Name')}<input value={hub.name} onChange={(event) => setSettings((v) => v ? { ...v, hubs: v.hubs.map((row, i) => i === index ? { ...row, name: event.target.value } : row) } : v)} /></label>
              <label>{t('p9Enabled')}<input type="checkbox" checked={hub.enabled !== false} onChange={(event) => setSettings((v) => v ? { ...v, hubs: v.hubs.map((row, i) => i === index ? { ...row, enabled: event.target.checked } : row) } : v)} /></label>
              <button type="button" disabled={busy || settings.hubs.length <= 1} onClick={() => setSettings((v) => v ? { ...v, hubs: v.hubs.filter((_, i) => i !== index) } : v)}>{t('p9Delete')}</button>
            </div>
          ))}
          <div className="toolbar">
            <button type="button" disabled={busy} onClick={() => setSettings((v) => v ? { ...v, hubs: [...v.hubs, { locationId: 0, regionId: 0, name: t('p9NewHubPlaceholder'), enabled: true }] } : v)}>{t('p9AddHub')}</button>
            <button type="button" disabled={busy} onClick={() => void saveSettings()}>{t('p9SaveSettings')}</button>
          </div>
          <p>{t('p9DefaultsNote')}</p>
        </>
      ) : null}

      {detail ? (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }} role="dialog" aria-modal="true" aria-label={t('p9OpportunityDetail')}>
          <div style={{ background: 'var(--panel, #141414)', color: 'var(--text, #eee)', maxWidth: 1040, width: '100%', maxHeight: '90vh', overflow: 'auto', padding: 20, borderRadius: 12 }}>
            <div className="toolbar">
              <h2 style={{ margin: 0 }}>{detail.opportunity.typeNameZh || detail.opportunity.typeNameEn} · {detail.opportunity.state}</h2>
              <button type="button" onClick={() => setDetail(null)}>{t('p9Close')}</button>
            </div>
            <p>{detail.opportunity.strategy === 'station_arbitrage' ? t('assetStationArbitrage') : t('p9CrossHubArbitrage')} · {detail.opportunity.buyLocationName} → {detail.opportunity.sellLocationName}</p>
            <div className="metric-grid">
              <div className="metric-card"><span>{t('p9SuggestedQuantity')}</span><strong>{detail.opportunity.suggestedQuantity}</strong></div>
              <div className="metric-card"><span>{t('p9BuyVwap')}</span><strong>{num(detail.opportunity.buyPrice)}</strong></div>
              <div className="metric-card"><span>{t('p9SellVwap')}</span><strong>{num(detail.opportunity.sellPrice)}</strong></div>
              <div className="metric-card"><span>{t('p9PurchaseCost')}</span><strong>{num(detail.opportunity.purchaseAmount, 0)}</strong></div>
              <div className="metric-card"><span>{t('p9SalesRevenue')}</span><strong>{num(detail.opportunity.salesRevenue, 0)}</strong></div>
              <div className="metric-card"><span>{t('p9BrokerageFee')}</span><strong>{num(detail.opportunity.brokerFees, 2)}</strong></div>
              <div className="metric-card"><span>{t('p9SalesTaxScc')}</span><strong>{num(detail.opportunity.salesTax, 2)}</strong></div>
              <div className="metric-card"><span>{t('p9ProfitAfterFees')}</span><strong>{num(detail.opportunity.feeNetProfit, 2)}</strong></div>
              <div className="metric-card"><span>{t('p9ComprehensiveNet')}</span><strong>{detail.opportunity.comprehensiveNetProfit == null ? detail.opportunity.comprehensiveStatus : num(detail.opportunity.comprehensiveNetProfit, 2)}</strong></div>
              <div className="metric-card"><span>{t('p9CapitalRequired')}</span><strong>{num(detail.opportunity.capitalRequired, 0)}</strong></div>
              <div className="metric-card"><span>ROI</span><strong>{pct(detail.opportunity.roiPct)}</strong></div>
              <div className="metric-card"><span>{t('colRisk')}</span><strong>{detail.opportunity.riskLevel}</strong></div>
              <div className="metric-card"><span>{t('dockDelta')}</span><strong>{detail.opportunity.spreadDetected ? t('p9Detected') : t('paperNoRiskFlags')}</strong></div>
              <div className="metric-card"><span>{t('marketTabBook')}</span><strong>{detail.opportunity.marketExecutable ? t('p9Executable') : t('p9NotExecutable')}</strong></div>
              <div className="metric-card"><span>{t('p9ProfitNetFees')}</span><strong>{detail.opportunity.profitAfterKnownFees ? t('p9Positive') : t('p9NotPositive')}</strong></div>
              <div className="metric-card"><span>{t('p9TransportCost')}</span><strong>{detail.opportunity.logisticsKnown ? num(detail.opportunity.logisticsCost, 2) : 'UNKNOWN'}</strong></div>
              <div className="metric-card"><span>{t('p9ComprehensiveKnown')}</span><strong>{detail.opportunity.overallProfitKnown ? t('p9Yes') : t('p9No')}</strong></div>
              <div className="metric-card"><span>{t('p9FullTradeConditions')}</span><strong>{detail.opportunity.tradePlanComplete ? t('p9Satisfied') : t('p9Unsatisfied')}</strong></div>
            </div>
            <p>{t('p9FeeDetailLine', { a: num(detail.opportunity.feeNetProfit, 2), b: detail.opportunity.logisticsKnown ? num(detail.opportunity.logisticsCost, 2) : 'UNKNOWN', c: detail.opportunity.comprehensiveNetProfit == null ? 'UNKNOWN' : num(detail.opportunity.comprehensiveNetProfit, 2), d: detail.opportunity.logisticsKnown ? t('paperNoRiskFlags') : t('p9TransportUnknownNote') })}</p>
            <p>{t('p9RiskSourceLine', { flags: String(detail.opportunity.riskFlags.join(t('p9ListSep')) || t('paperNoRiskFlags')), source: String(detail.opportunity.dataSource), version: String(detail.opportunity.calculationVersion || detail.originalSnapshot?.calculation?.version || 'N/A') })}</p>
            <p>{t('p9BuySnapshotLine', { id: String(detail.opportunity.buySnapshotId || 'N/A'), at: String(dateTime(detail.opportunity.buySnapshotAt)), age: String(detail.opportunity.buySnapshotAgeMinutes ?? 'N/A') })}<br />{t('p9SellSnapshotLine', { id: String(detail.opportunity.sellSnapshotId || 'N/A'), at: String(dateTime(detail.opportunity.sellSnapshotAt)), age: String(detail.opportunity.sellSnapshotAgeMinutes ?? 'N/A') })}</p>
            <h3>{t('p9BuyBook')}</h3>
            <div className="data-table-wrap">
              <table className="data-table">
                <thead><tr><th>{t('marketPrice')}</th><th>{t('p9RemainingQty')}</th><th>{t('p9LevelFilled')}</th><th>{t('p9Cumulative')}</th><th>Order ID</th></tr></thead>
                <tbody>
                  {matchLevels(detail.originalSnapshot?.buy?.asks || [], detail.opportunity.suggestedQuantity, false).map((row, index) => (
                    <tr key={`ba-${index}`}><td>{num(row.price)}</td><td>{row.volumeRemain}</td><td>{row.take}</td><td>{row.cumulative}</td><td>{String((detail.originalSnapshot?.buy?.asks || [])[index]?.orderId || '')}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h3>{t('p9SellBook')}</h3>
            <div className="data-table-wrap">
              <table className="data-table">
                <thead><tr><th>{t('marketPrice')}</th><th>{t('p9RemainingQty')}</th><th>{t('p9LevelFilled')}</th><th>{t('p9Cumulative')}</th><th>Order ID</th></tr></thead>
                <tbody>
                  {matchLevels(detail.originalSnapshot?.sell?.bids || [], detail.opportunity.suggestedQuantity, true).map((row, index) => (
                    <tr key={`sb-${index}`}><td>{num(row.price)}</td><td>{row.volumeRemain}</td><td>{row.take}</td><td>{row.cumulative}</td><td>{String((detail.originalSnapshot?.sell?.bids || [])[index]?.orderId || '')}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h3>{t('p9CalculationNotes')}</h3>
            <pre>{JSON.stringify(detail.originalSnapshot?.calculation || {}, null, 2)}</pre>
            <h3>{t('p9Plans')}</h3>
            {detail.plan
              ? <pre>{JSON.stringify(detail.plan, null, 2)}</pre>
              : <button type="button" disabled={busy} onClick={() => void createPlan(detail.opportunity.opportunityId)}>{t('p9GenerateTradePlan')}</button>}
            <p>{t('p9ReadonlyNote')}</p>
          </div>
        </div>
      ) : null}
    </section>
  );
}
