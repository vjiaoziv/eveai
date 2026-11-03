import { useCallback, useEffect, useState } from 'react';
import { webApi } from '../api';
import { ChartIcon, MenuIcon } from '../icons';

type P9Tab = 'overview' | 'opportunities' | 'plans' | 'assets' | 'inventory' | 'trades' | 'performance' | 'risk' | 'settings';

type P9Overview = {
  portfolio: {
    wallet: { balance: number | null; syncedAt: string | null };
    funding: Record<string, number | string | null>;
    inventory: Record<string, number>;
    performance: Record<string, number | null>;
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

const num = (value: unknown, digits = 2): string => typeof value === 'number' && Number.isFinite(value)
  ? value.toLocaleString('zh-CN', { maximumFractionDigits: digits })
  : 'N/A';
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
  const [tab, setTab] = useState<P9Tab>('overview');
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
      setError(reason instanceof Error ? reason.message : 'P9 数据加载失败');
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
      setError(reason instanceof Error ? reason.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }, [load, tab]);

  const scan = () => {
    const typeIds = [...new Set(scanTypeIds.split(/[\s,，]+/).map((value) => Number(value)))]
      .filter((value) => Number.isSafeInteger(value) && value > 0)
      .slice(0, 500);
    return runAction(() => webApi.p9.scan(csrfToken, typeIds), typeIds.length > 0
      ? `已按 ${typeIds.length} 个指定 Type ID 扫描。`
      : '扫描完成，机会已按最新本地订单簿更新。');
  };
  const openDetail = (opportunityId: string) => runAction(async () => {
    const payload = await webApi.p9.opportunity(opportunityId) as P9OpportunityDetail;
    setDetail(payload);
  }, '机会详情已加载。');
  const analyze = (mode: 'opportunity' | 'daily', opportunityId?: string) => runAction(async () => {
    const payload = await webApi.p9.analyze({ mode, opportunityIds: opportunityId ? [opportunityId] : [] }, csrfToken) as { analysis: string };
    setAnalysis(payload.analysis);
  }, 'AI 分析完成；所有数字仍以数据库字段为准。');
  const createPlan = (opportunityId: string) => runAction(() => webApi.p9.createPlan(opportunityId, csrfToken), '交易方案已生成。');
  const archiveOpportunity = (opportunityId: string) => runAction(() => webApi.p9.transitionOpportunity(opportunityId, 'ARCHIVED', csrfToken), '机会已归档。');
  const confirmPlan = (planId: string) => runAction(() => webApi.p9.transitionPlan(planId, 'USER_CONFIRMED', csrfToken), '交易方案已确认。');
  const syncEsiTrades = () => runAction(() => webApi.p9.syncEsiTrades(csrfToken), 'ESI 真实交易同步已执行。');
  const rebuildLedger = () => runAction(() => webApi.p9.rebuildLedger(csrfToken), '真实库存与盈亏已独立重算。');
  const syncAssets = () => runAction(() => webApi.profile.sync(['wallet', 'assets', 'orders'], csrfToken), '钱包、资产和挂单已按 ESI 权限同步。');

  const saveSettings = async () => {
    if (!settings) return;
    await runAction(() => webApi.p9.saveSettings(settings, csrfToken), '扫描设置已保存。');
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
    }, csrfToken), '真实交易已录入并重算库存/FIFO 盈亏。');
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
    }, csrfToken), lotForm.costPerUnit === '' ? '库存已记录，成本保持 UNKNOWN。' : '库存采购成本已人工确认。');
  };

  const realizedTrades = trades.filter((row) => row.direction === 'sell' && row.pnlStatus === 'CALCULATED');
  const unknownTrades = trades.filter((row) => row.pnlStatus === 'UNKNOWN_COST');
  const realizedFromRows = realizedTrades.reduce((sum, row) => sum + Number(row.realizedPnl || 0), 0);

  if (!overview) {
    return error
      ? <div className="screen-error" role="alert">{error}</div>
      : <div className="app-loading" aria-label="加载真实交易工作台"><span /><span /><span /></div>;
  }
  const tabLabels: Record<P9Tab, string> = {
    overview: '交易总览',
    opportunities: '机会中心',
    plans: '交易方案',
    assets: '真实资产',
    inventory: '库存管理',
    trades: '真实交易记录',
    performance: '策略绩效',
    risk: '风险中心',
    settings: '系统设置',
  };

  return (
    <section className="market-screen">
      <header className="market-screen__topbar">
        <button className="icon-button" type="button" onClick={onMenu} aria-label="打开菜单"><MenuIcon size={20} /></button>
        <h1><ChartIcon size={18} /> EVEAI 真实交易工作台</h1>
        <span className="status-pill">REAL 与 PAPER 完全隔离 · 自动交易禁用</span>
        <button className="button button--secondary" type="button" disabled={busy} onClick={() => void scan()}>立即扫描</button>
        <button className="button button--secondary" type="button" disabled={busy} onClick={() => void load(tab)}>刷新</button>
      </header>

      <nav className="market-tabs" aria-label="真实交易工作台视图">
        {(Object.keys(tabLabels) as P9Tab[]).map((key) => (
          <button key={key} type="button" className={tab === key ? 'market-tab market-tab--active' : 'market-tab'} onClick={() => setTab(key)}>
            {tabLabels[key]}
          </button>
        ))}
      </nav>

      {error ? <div className="screen-error" role="alert">{error}</div> : null}
      {notice ? <div className="screen-success" role="status">{notice}</div> : null}
      {busy ? <p>处理中，请稍候…</p> : null}

      {tab === 'overview' ? (
        <>
          <div className="metric-grid">
            <div className="metric-card"><span>当前 ISK</span><strong>{num(overview.portfolio.wallet.balance, 0)}</strong></div>
            <div className="metric-card"><span>可用资金</span><strong>{num(overview.portfolio.funding.availableIsk, 0)}</strong></div>
            <div className="metric-card"><span>挂单占用</span><strong>{num(overview.portfolio.funding.openOrderEscrow, 0)}</strong></div>
            <div className="metric-card"><span>已知库存成本</span><strong>{num(overview.portfolio.funding.knownInventoryCost, 0)}</strong></div>
            <div className="metric-card"><span>完整条件机会</span><strong>{num(overview.portfolio.opportunities.actionable, 0)}</strong></div>
            <div className="metric-card"><span>观察中（条件未完备）</span><strong>{num(overview.portfolio.opportunities.watching, 0)}</strong></div>
            <div className="metric-card"><span>过期/陈旧</span><strong>{num(overview.portfolio.opportunities.staleOrExpired, 0)}</strong></div>
            <div className="metric-card"><span>真实交易</span><strong>{num(overview.trades.count, 0)}</strong></div>
            <div className="metric-card"><span>已实现净盈亏</span><strong>{num(overview.portfolio.performance.realizedNetPnl, 2)}</strong></div>
            <div className="metric-card"><span>未实现盈亏</span><strong>{num(overview.portfolio.performance.unrealizedPnl, 2)}</strong></div>
            <div className="metric-card"><span>未知成本库存</span><strong>{num(overview.portfolio.inventory.unknownLotCount, 0)}</strong></div>
            <div className="metric-card"><span>ESI 行情状态</span><strong>{marketStatus ? (marketStatus.stale ? 'STALE' : marketStatus.status.toUpperCase()) : 'LOADING'}</strong></div>
            <div className="metric-card"><span>行情快照时间</span><strong>{dateTime(marketStatus?.snapshot_time)}</strong></div>
            <div className="metric-card"><span>行情数据行</span><strong>{num(marketStatus?.rows_loaded, 0)}</strong></div>
            <div className="metric-card"><span>行情整体陈旧</span><strong>{marketStatus ? (marketStatus.stale ? '是' : '否') : 'N/A'}</strong></div>
          </div>
          <h2>数据同步状态</h2>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>数据集</th><th>状态</th><th>同步时间</th><th>有效期</th><th>错误</th></tr></thead>
              <tbody>
                {overview.portfolio.sync.map((row) => (
                  <tr key={row.dataset}><td>{row.dataset}</td><td>{row.status}</td><td>{dateTime(row.syncedAt)}</td><td>{dateTime(row.expiresAt)}</td><td>{row.error || '无'}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <h2>ESI 行情与贸易中心状态</h2>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>贸易中心</th><th>区域 ID</th><th>最近采集</th><th>年龄（分钟）</th><th>状态</th><th>错误</th></tr></thead>
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
                      <td>{region?.last_error || marketStatus?.last_error || '无'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <h2>最近扫描</h2>
          <p>{overview.marketScan ? `${String(overview.marketScan.status)} · ${dateTime(overview.marketScan.started_at)} · ${String(overview.marketScan.summary_json || '')}` : '尚未执行 P9 扫描'}</p>
        </>
      ) : null}

      {tab === 'opportunities' ? (
        <>
          <div className="toolbar">
            <input value={filters.q} onChange={(event) => setFilters((current) => ({ ...current, q: event.target.value }))} placeholder="搜索商品名称或 Type ID" />
            <select value={filters.state} onChange={(event) => setFilters((current) => ({ ...current, state: event.target.value }))}>
              <option value="">全部状态</option><option>ACTIONABLE</option><option>WATCHING</option><option>STALE</option><option>EXPIRED</option><option>REJECTED</option><option>ARCHIVED</option>
            </select>
            <select value={filters.strategy} onChange={(event) => setFilters((current) => ({ ...current, strategy: event.target.value }))}>
              <option value="">全部策略</option><option value="station_arbitrage">站内套利</option><option value="regional_hauling">跨贸易中心套利</option>
            </select>
            <select value={filters.sort} onChange={(event) => setFilters((current) => ({ ...current, sort: event.target.value }))}>
              <option value="net">净利润</option><option value="roi">资金回报率</option><option value="capital">所需资金</option><option value="liquidity">流动性</option><option value="risk">风险</option>
            </select>
            <input value={scanTypeIds} onChange={(event) => setScanTypeIds(event.target.value)} placeholder="指定 Type ID（逗号分隔，留空=自动候选）" />
            <button type="button" disabled={busy} onClick={() => void scan()}>按 Type 扫描</button>
          </div>
          {opportunities.length === 0 ? <p className="screen-empty">暂无机会。请先执行扫描并确认市场快照已同步。</p> : null}
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>机会/商品</th><th>策略与路线</th><th>建议量</th><th>四层利润</th><th>资金/ROI</th><th>风险与数据</th><th>操作</th></tr></thead>
              <tbody>
                {opportunities.map((row) => (
                  <tr key={row.opportunityId}>
                    <td><strong>{row.typeNameZh || row.typeNameEn}</strong><br /><small>{row.typeId} · {row.state === 'WATCHING' ? 'WATCHING 观察中' : row.state === 'ACTIONABLE' ? 'ACTIONABLE 完整条件' : row.state}</small></td>
                    <td>{row.strategy === 'station_arbitrage' ? '站内套利' : '跨贸易中心'}<br /><small>{row.buyLocationName}<br />→ {row.sellLocationName}</small></td>
                    <td>{row.suggestedQuantity}<br /><small>可执行 {row.executableQuantity}</small></td>
                    <td>
                      理论 {num(row.theoreticalGrossProfit, 0)}<br />
                      可执行 {num(row.executableGrossProfit, 0)}<br />
                      费后 {num(row.feeNetProfit, 0)}<br />
                      综合 {row.comprehensiveNetProfit == null ? row.comprehensiveStatus : num(row.comprehensiveNetProfit, 0)}
                    </td>
                    <td>{num(row.capitalRequired, 0)}<br />{pct(row.roiPct)}</td>
                    <td>{row.riskLevel} · 流动性 {row.liquidity}<br /><small>价差 {row.spreadDetected ? '已发现' : '无'} · 订单簿 {row.marketExecutable ? '可执行' : '不可执行'} · 费后利润 {row.profitAfterKnownFees ? '为正' : '非正'} · 物流 {row.logisticsKnown ? '已知' : 'UNKNOWN'} · 完整条件 {row.tradePlanComplete ? '已满足' : '未满足'}</small><br /><small>{row.riskFlags.join('、') || '无额外标记'}</small><br /><small>更新 {dateTime(row.updatedAt)}<br />有效至 {dateTime(row.expiresAt)}</small></td>
                    <td>
                      <button type="button" disabled={busy} onClick={() => void openDetail(row.opportunityId)}>详情</button>
                      <button type="button" disabled={busy} onClick={() => void createPlan(row.opportunityId)}>生成方案</button>
                      <button type="button" disabled={busy} onClick={() => void analyze('opportunity', row.opportunityId)}>AI 解释</button>
                      <button type="button" disabled={busy} onClick={() => void archiveOpportunity(row.opportunityId)}>归档</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {analysis ? <><h2>AI 研究说明</h2><pre>{analysis}</pre></> : null}
        </>
      ) : null}

      {tab === 'plans' ? (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th>方案</th><th>状态/有效期</th><th>商品与数量</th><th>预计成本/收入</th><th>预计费后利润</th><th>运输成本</th><th>综合利润</th><th>操作</th></tr></thead>
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
                  <td>{row.status === 'PLANNED' ? <button type="button" disabled={busy} onClick={() => void confirmPlan(row.planId)}>人工确认</button> : <small>等待真实成交回填</small>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {plans.length === 0 ? <p className="screen-empty">尚无交易方案。</p> : null}
        </div>
      ) : null}
      {tab === 'assets' ? (
        <>
          <div className="metric-grid">
            <div className="metric-card"><span>钱包余额</span><strong>{num(overview.portfolio.wallet.balance, 0)}</strong></div>
            <div className="metric-card"><span>挂单占用</span><strong>{num(overview.portfolio.funding.openOrderEscrow, 0)}</strong></div>
            <div className="metric-card"><span>原始资产行</span><strong>{num(overview.portfolio.inventory.rawAssetCount, 0)}</strong></div>
            <div className="metric-card"><span>ESI 资产状态</span><strong>{overview.portfolio.dataFreshness.assets}</strong></div>
          </div>
          <p>未知用途资金与未知成本资产保持 <strong>UNKNOWN</strong>，不会并入可用 ISK 或已实现收益。</p>
          <div className="toolbar"><button type="button" disabled={busy} onClick={() => void syncAssets()}>同步 ESI 钱包/资产/挂单</button><button type="button" disabled={busy} onClick={() => void rebuildLedger()}>独立重算库存与盈亏</button></div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Item</th><th>商品</th><th>地点</th><th>数量</th><th>确认成本</th><th>逐档退出净值</th><th>未实现盈亏</th></tr></thead>
              <tbody>
                {(inventory?.rawAssets || []).map((row) => (
                  <tr key={String(row.itemId)}>
                    <td>{String(row.itemId)}</td><td>{String(row.typeName || row.typeId)}</td><td>{String(row.locationId)}</td><td>{String(row.quantity)}</td>
                    <td>{row.confirmedCostPerUnit == null ? 'UNKNOWN' : num(row.confirmedCostPerUnit)}</td>
                    <td>{num(row.executableExitNet, 2)}{row.depthLimited ? '（深度受限）' : ''}</td>
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
          <h2>人工确认库存成本</h2>
          <div className="form-grid">
            <label>Item ID（可空）<input value={lotForm.itemId} onChange={(event) => setLotForm((v) => ({ ...v, itemId: event.target.value }))} /></label>
            <label>Type ID<input value={lotForm.typeId} onChange={(event) => setLotForm((v) => ({ ...v, typeId: event.target.value }))} /></label>
            <label>地点 ID<input value={lotForm.locationId} onChange={(event) => setLotForm((v) => ({ ...v, locationId: event.target.value }))} /></label>
            <label>数量<input value={lotForm.quantity} onChange={(event) => setLotForm((v) => ({ ...v, quantity: event.target.value }))} /></label>
            <label>单位成本（留空=UNKNOWN）<input value={lotForm.costPerUnit} onChange={(event) => setLotForm((v) => ({ ...v, costPerUnit: event.target.value }))} /></label>
            <label>取得时间<input type="datetime-local" value={lotForm.acquiredAt} onChange={(event) => setLotForm((v) => ({ ...v, acquiredAt: event.target.value }))} /></label>
            <label>备注<input value={lotForm.notes} onChange={(event) => setLotForm((v) => ({ ...v, notes: event.target.value }))} /></label>
          </div>
          <button type="button" disabled={busy} onClick={() => void createLot()}>保存库存成本</button>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Lot</th><th>商品</th><th>地点</th><th>数量</th><th>成本</th><th>来源</th><th>退出净值/盈亏</th></tr></thead>
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
            <button type="button" disabled={busy} onClick={() => void syncEsiTrades()}>同步 ESI 真实交易</button>
            <button type="button" disabled={busy} onClick={() => void rebuildLedger()}>重建 FIFO 盈亏</button>
          </div>
          <h2>人工录入真实成交</h2>
          <div className="form-grid">
            <label>幂等 Key<input value={tradeForm.clientKey} onChange={(event) => setTradeForm((v) => ({ ...v, clientKey: event.target.value }))} /></label>
            <label>方向<select value={tradeForm.direction} onChange={(event) => setTradeForm((v) => ({ ...v, direction: event.target.value }))}><option value="buy">买入</option><option value="sell">卖出</option></select></label>
            <label>Type ID<input value={tradeForm.typeId} onChange={(event) => setTradeForm((v) => ({ ...v, typeId: event.target.value }))} /></label>
            <label>地点 ID<input value={tradeForm.locationId} onChange={(event) => setTradeForm((v) => ({ ...v, locationId: event.target.value }))} /></label>
            <label>数量<input value={tradeForm.quantity} onChange={(event) => setTradeForm((v) => ({ ...v, quantity: event.target.value }))} /></label>
            <label>单价<input value={tradeForm.price} onChange={(event) => setTradeForm((v) => ({ ...v, price: event.target.value }))} /></label>
            <label>实际费用<input value={tradeForm.fee} onChange={(event) => setTradeForm((v) => ({ ...v, fee: event.target.value }))} /></label>
            <label>交易时间<input type="datetime-local" value={tradeForm.tradeTime} onChange={(event) => setTradeForm((v) => ({ ...v, tradeTime: event.target.value }))} /></label>
            <label>备注<input value={tradeForm.notes} onChange={(event) => setTradeForm((v) => ({ ...v, notes: event.target.value }))} /></label>
          </div>
          <button type="button" disabled={busy} onClick={() => void recordTrade()}>录入并重算</button>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>交易</th><th>方向/来源</th><th>商品/地点</th><th>数量/价格/费用</th><th>时间</th><th>已实现盈亏</th></tr></thead>
              <tbody>
                {trades.map((row) => (
                  <tr key={row.tradeId}>
                    <td>{row.tradeId}<br /><small>{String(row.clientKey)}</small></td>
                    <td>{row.direction} · {row.source}</td>
                    <td>{row.typeId}<br /><small>{String(row.locationId)}</small></td>
                    <td>{row.quantity} × {num(row.price)}<br />费用 {num(row.fee)}</td>
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
            <div className="metric-card"><span>真实交易数</span><strong>{num(overview.trades.count, 0)}</strong></div>
            <div className="metric-card"><span>买入/卖出</span><strong>{num(overview.trades.buyCount, 0)} / {num(overview.trades.sellCount, 0)}</strong></div>
            <div className="metric-card"><span>已实现净盈亏</span><strong>{num(overview.portfolio.performance.realizedNetPnl, 2)}</strong></div>
            <div className="metric-card"><span>已支付费用</span><strong>{num(overview.portfolio.performance.feesPaid, 2)}</strong></div>
            <div className="metric-card"><span>未知成本移动</span><strong>{num(overview.portfolio.performance.unknownCostMoveCount, 0)}</strong></div>
            <div className="metric-card"><span>当前列表可确认收益</span><strong>{num(realizedFromRows, 2)}</strong></div>
          </div>
          <p>页面只汇总 REAL 数据；Paper Mode A/B/C 收益在独立 Paper Trading 页面统计，不与本页合并。</p>
          <p>未知成本交易：{unknownTrades.length}；这些记录不进入已确认盈利排名。</p>
          <button type="button" disabled={busy} onClick={() => void analyze('daily')}>生成每日 AI 交易报告</button>
          {analysis ? <pre>{analysis}</pre> : null}
        </>
      ) : null}

      {tab === 'risk' && risk ? (
        <>
          <div className="metric-grid">
            <div className="metric-card"><span>未知成本库存</span><strong>{risk.unknownInventoryLots}</strong></div>
            <div className="metric-card"><span>陈旧/过期机会</span><strong>{risk.stale.reduce((sum, row) => sum + row.count, 0)}</strong></div>
            <div className="metric-card"><span>同步错误</span><strong>{risk.syncErrors.length}</strong></div>
            <div className="metric-card"><span>自动真实交易</span><strong>DISABLED</strong></div>
          </div>
          <div className="data-table-wrap">
            <table className="data-table"><thead><tr><th>风险标记</th><th>数量</th></tr></thead><tbody>{risk.flags.map((row) => <tr key={row.flag}><td>{row.flag}</td><td>{row.count}</td></tr>)}</tbody></table>
          </div>
          <h2>风控参数</h2>
          <pre>{JSON.stringify(risk.controls, null, 2)}</pre>
          <h2>同步错误</h2>
          <pre>{JSON.stringify(risk.syncErrors, null, 2)}</pre>
        </>
      ) : null}

      {tab === 'settings' && settings ? (
        <>
          <div className="form-grid">
            <label>最低净利润<input type="number" value={settings.minNetProfit} onChange={(event) => setSettings((v) => v ? { ...v, minNetProfit: Number(event.target.value) } : v)} /></label>
            <label>最低 ROI %<input type="number" value={settings.minRoiPct} onChange={(event) => setSettings((v) => v ? { ...v, minRoiPct: Number(event.target.value) } : v)} /></label>
            <label>单次最大资金<input type="number" value={settings.maxCapital} onChange={(event) => setSettings((v) => v ? { ...v, maxCapital: Number(event.target.value) } : v)} /></label>
            <label>最大行情年龄（分钟）<input type="number" value={settings.maxMarketAgeMinutes} onChange={(event) => setSettings((v) => v ? { ...v, maxMarketAgeMinutes: Number(event.target.value) } : v)} /></label>
            <label>最大结果数<input type="number" value={settings.maxResults} onChange={(event) => setSettings((v) => v ? { ...v, maxResults: Number(event.target.value) } : v)} /></label>
            <label>自动扫描间隔（分钟）<input type="number" value={settings.autoScanIntervalMinutes} onChange={(event) => setSettings((v) => v ? { ...v, autoScanIntervalMinutes: Number(event.target.value) } : v)} /></label>
            <label>自动扫描<input type="checkbox" checked={settings.autoScanEnabled} onChange={(event) => setSettings((v) => v ? { ...v, autoScanEnabled: event.target.checked } : v)} /></label>
          </div>
          <h2>贸易中心白名单</h2>
          {settings.hubs.map((hub, index) => (
            <div className="form-grid" key={`${hub.locationId}-${index}`}>
              <label>地点 ID<input type="number" value={hub.locationId} onChange={(event) => setSettings((v) => v ? { ...v, hubs: v.hubs.map((row, i) => i === index ? { ...row, locationId: Number(event.target.value) } : row) } : v)} /></label>
              <label>区域 ID<input type="number" value={hub.regionId} onChange={(event) => setSettings((v) => v ? { ...v, hubs: v.hubs.map((row, i) => i === index ? { ...row, regionId: Number(event.target.value) } : row) } : v)} /></label>
              <label>名称<input value={hub.name} onChange={(event) => setSettings((v) => v ? { ...v, hubs: v.hubs.map((row, i) => i === index ? { ...row, name: event.target.value } : row) } : v)} /></label>
              <label>启用<input type="checkbox" checked={hub.enabled !== false} onChange={(event) => setSettings((v) => v ? { ...v, hubs: v.hubs.map((row, i) => i === index ? { ...row, enabled: event.target.checked } : row) } : v)} /></label>
              <button type="button" disabled={busy || settings.hubs.length <= 1} onClick={() => setSettings((v) => v ? { ...v, hubs: v.hubs.filter((_, i) => i !== index) } : v)}>删除</button>
            </div>
          ))}
          <div className="toolbar">
            <button type="button" disabled={busy} onClick={() => setSettings((v) => v ? { ...v, hubs: [...v.hubs, { locationId: 0, regionId: 0, name: '新贸易中心', enabled: true }] } : v)}>添加贸易中心</button>
            <button type="button" disabled={busy} onClick={() => void saveSettings()}>保存系统设置</button>
          </div>
          <p>这些默认阈值仅是工程默认值，不代表经过实盘验证的最佳参数。</p>
        </>
      ) : null}

      {detail ? (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }} role="dialog" aria-modal="true" aria-label="机会详情">
          <div style={{ background: 'var(--panel, #141414)', color: 'var(--text, #eee)', maxWidth: 1040, width: '100%', maxHeight: '90vh', overflow: 'auto', padding: 20, borderRadius: 12 }}>
            <div className="toolbar">
              <h2 style={{ margin: 0 }}>{detail.opportunity.typeNameZh || detail.opportunity.typeNameEn} · {detail.opportunity.state}</h2>
              <button type="button" onClick={() => setDetail(null)}>关闭</button>
            </div>
            <p>{detail.opportunity.strategy === 'station_arbitrage' ? '站内套利' : '跨贸易中心套利'} · {detail.opportunity.buyLocationName} → {detail.opportunity.sellLocationName}</p>
            <div className="metric-grid">
              <div className="metric-card"><span>建议数量</span><strong>{detail.opportunity.suggestedQuantity}</strong></div>
              <div className="metric-card"><span>买入加权价</span><strong>{num(detail.opportunity.buyPrice)}</strong></div>
              <div className="metric-card"><span>卖出加权价</span><strong>{num(detail.opportunity.sellPrice)}</strong></div>
              <div className="metric-card"><span>采购成本</span><strong>{num(detail.opportunity.purchaseAmount, 0)}</strong></div>
              <div className="metric-card"><span>销售收入</span><strong>{num(detail.opportunity.salesRevenue, 0)}</strong></div>
              <div className="metric-card"><span>经纪人费</span><strong>{num(detail.opportunity.brokerFees, 2)}</strong></div>
              <div className="metric-card"><span>销售税/SCC</span><strong>{num(detail.opportunity.salesTax, 2)}</strong></div>
              <div className="metric-card"><span>费用后净利润</span><strong>{num(detail.opportunity.feeNetProfit, 2)}</strong></div>
              <div className="metric-card"><span>综合净利润</span><strong>{detail.opportunity.comprehensiveNetProfit == null ? detail.opportunity.comprehensiveStatus : num(detail.opportunity.comprehensiveNetProfit, 2)}</strong></div>
              <div className="metric-card"><span>资金需求</span><strong>{num(detail.opportunity.capitalRequired, 0)}</strong></div>
              <div className="metric-card"><span>ROI</span><strong>{pct(detail.opportunity.roiPct)}</strong></div>
              <div className="metric-card"><span>风险</span><strong>{detail.opportunity.riskLevel}</strong></div>
              <div className="metric-card"><span>价差</span><strong>{detail.opportunity.spreadDetected ? '已发现' : '无'}</strong></div>
              <div className="metric-card"><span>订单簿</span><strong>{detail.opportunity.marketExecutable ? '可执行' : '不可执行'}</strong></div>
              <div className="metric-card"><span>费后利润</span><strong>{detail.opportunity.profitAfterKnownFees ? '为正' : '非正'}</strong></div>
              <div className="metric-card"><span>运输成本</span><strong>{detail.opportunity.logisticsKnown ? num(detail.opportunity.logisticsCost, 2) : 'UNKNOWN'}</strong></div>
              <div className="metric-card"><span>综合利润可知</span><strong>{detail.opportunity.overallProfitKnown ? '是' : '否'}</strong></div>
              <div className="metric-card"><span>完整交易条件</span><strong>{detail.opportunity.tradePlanComplete ? '已满足' : '未满足'}</strong></div>
            </div>
            <p>费用后净利润 {num(detail.opportunity.feeNetProfit, 2)}（仅扣除已知费用）；运输成本 {detail.opportunity.logisticsKnown ? num(detail.opportunity.logisticsCost, 2) : 'UNKNOWN'}；综合净利润 {detail.opportunity.comprehensiveNetProfit == null ? 'UNKNOWN' : num(detail.opportunity.comprehensiveNetProfit, 2)}；未知成本：{detail.opportunity.logisticsKnown ? '无' : '运输成本待确认，不得视为 0'}。</p>
            <p>风险标记：{detail.opportunity.riskFlags.join('、') || '无'}。数据源：{detail.opportunity.dataSource} · 计算版本：{detail.opportunity.calculationVersion || String(detail.originalSnapshot?.calculation?.version || 'N/A')}</p>
            <p>买入快照：{detail.opportunity.buySnapshotId || 'N/A'} · {dateTime(detail.opportunity.buySnapshotAt)}（{detail.opportunity.buySnapshotAgeMinutes ?? 'N/A'} 分钟）<br />卖出快照：{detail.opportunity.sellSnapshotId || 'N/A'} · {dateTime(detail.opportunity.sellSnapshotAt)}（{detail.opportunity.sellSnapshotAgeMinutes ?? 'N/A'} 分钟）</p>
            <h3>买入订单簿（最低卖单优先）</h3>
            <div className="data-table-wrap">
              <table className="data-table">
                <thead><tr><th>价格</th><th>剩余量</th><th>本档成交</th><th>累计</th><th>Order ID</th></tr></thead>
                <tbody>
                  {matchLevels(detail.originalSnapshot?.buy?.asks || [], detail.opportunity.suggestedQuantity, false).map((row, index) => (
                    <tr key={`ba-${index}`}><td>{num(row.price)}</td><td>{row.volumeRemain}</td><td>{row.take}</td><td>{row.cumulative}</td><td>{String((detail.originalSnapshot?.buy?.asks || [])[index]?.orderId || '')}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h3>卖出订单簿（最高买单优先）</h3>
            <div className="data-table-wrap">
              <table className="data-table">
                <thead><tr><th>价格</th><th>剩余量</th><th>本档成交</th><th>累计</th><th>Order ID</th></tr></thead>
                <tbody>
                  {matchLevels(detail.originalSnapshot?.sell?.bids || [], detail.opportunity.suggestedQuantity, true).map((row, index) => (
                    <tr key={`sb-${index}`}><td>{num(row.price)}</td><td>{row.volumeRemain}</td><td>{row.take}</td><td>{row.cumulative}</td><td>{String((detail.originalSnapshot?.sell?.bids || [])[index]?.orderId || '')}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h3>计算说明</h3>
            <pre>{JSON.stringify(detail.originalSnapshot?.calculation || {}, null, 2)}</pre>
            <h3>交易方案</h3>
            {detail.plan
              ? <pre>{JSON.stringify(detail.plan, null, 2)}</pre>
              : <button type="button" disabled={busy} onClick={() => void createPlan(detail.opportunity.opportunityId)}>生成交易方案</button>}
            <p>本阶段只生成建议；真实下单、撤单和资产操作始终由用户在 EVE 客户端人工执行。ESI 全链路保持只读。</p>
          </div>
        </div>
      ) : null}
    </section>
  );
}
