import { useCallback, useEffect, useState } from 'react';
import { webApi } from '../api';
import { ChartIcon, MenuIcon } from '../icons';

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

const TAG_LABELS: Record<string, string> = {
  SELF_USE: '自用', FOR_SALE: '待出售', PRODUCTION: '生产材料', MISSION: '任务用途',
  SPARE: '备用装备', TRADE_STOCK: '交易库存', HOLD: '暂不处理',
};

const CHANGE_LABELS: Record<string, string> = {
  ADDED: '新增', QTY_INCREASED: '数量增加', QTY_DECREASED: '数量减少', MOVED: '位置变化',
  REMOVED: '消失', REAPPEARED: '重新出现', CONTAINER_CHANGED: '容器变化',
};

const BUCKETS = [
  '', 'SHIPS', 'SHIP_MODULES', 'DRONES', 'AMMO', 'ORES_MINERALS', 'MANUFACTURING',
  'BPO', 'BPC', 'MISSION', 'IMPLANTS', 'CONSUMABLES', 'TRADING_GOODS', 'OTHER', 'UNKNOWN',
];

const BUCKET_LABELS: Record<string, string> = {
  SHIPS: '舰船', SHIP_MODULES: '舰船装备', DRONES: '无人机', AMMO: '弹药',
  ORES_MINERALS: '矿石与矿物', MANUFACTURING: '制造材料', BPO: '蓝图原件 BPO',
  BPC: '蓝图复制件 BPC', MISSION: '任务物品', IMPLANTS: '植入体',
  CONSUMABLES: '消耗品', TRADING_GOODS: '贸易商品', OTHER: '其他物品', UNKNOWN: '未知分类',
};

type Props = { onMenu: () => void; csrfToken: string };

export function AssetScreen({ onMenu, csrfToken }: Props) {
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
  }, [characterId, changeQuery]);

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
      setError(reason instanceof Error ? reason.message : '资产数据加载失败');
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
      setError(reason instanceof Error ? reason.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }, [loadTab, tab]);

  const syncCharacter = (targetId: number) =>
    runAction(() => webApi.assets.sync(targetId, csrfToken), 'ESI 资产只读同步已执行。');
  const runValuation = () => characterId === null
    ? Promise.resolve()
    : runAction(() => webApi.assets.runValuation({ characterId }, csrfToken), '多口径估值已执行。');
  const recomputeMatches = () => characterId === null
    ? Promise.resolve()
    : runAction(() => webApi.assets.recomputeMatches(characterId, csrfToken), '库存与机会联动已重新计算。');
  const saveTag = (itemId: number, tag: string) =>
    runAction(() => webApi.assets.setTag(itemId, tag || null, csrfToken), '本地标签已保存；不会发送到 EVE。');

  const openItem = async (itemId: number) => {
    setBusy(true);
    setError(null);
    try {
      const payload = await webApi.assets.item(itemId) as Record<string, any>;
      setSelectedItem(payload.item);
      setTab('detail');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '物品详情加载失败');
    } finally {
      setBusy(false);
    }
  };

  const compareSnapshots = () => runAction(async () => {
    if (!compareFrom || !compareTo) return;
    setCompareResult(await webApi.assets.compareSnapshots(compareFrom, compareTo) as Record<string, any>);
  }, '快照对比完成；结果仅表示观察到的变化。');

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
    { id: 'overview', label: '资产总览' },
    { id: 'characters', label: '角色资产' },
    { id: 'inventory', label: '库存列表' },
    { id: 'detail', label: '资产详情' },
    { id: 'changes', label: '资产变化' },
    { id: 'valuation', label: '估值分析' },
    { id: 'opportunities', label: '库存与套利机会' },
  ];

  return (
    <section className="market-screen">
      <header className="market-screen__topbar asset-screen__topbar">
        <button className="icon-button" type="button" onClick={onMenu} aria-label="打开菜单"><MenuIcon size={20} /></button>
        <h1><ChartIcon size={18} /> EVEAI 真实资产工作台</h1>
        <span className="status-pill">ESI GET-only · 真实资产写入禁用</span>
        <select
          className="market-select"
          value={characterId ?? ''}
          onChange={(event) => setCharacterId(Number(event.target.value))}
          aria-label="选择角色"
        >
          {characters.map((row) => (
            <option key={row.characterId} value={row.characterId}>{row.characterName || `角色 ${row.characterId}`}</option>
          ))}
        </select>
        <button className="button button--secondary" type="button" disabled={busy || characterId === null} onClick={() => characterId !== null && void syncCharacter(characterId)}>
          同步当前角色
        </button>
        <button className="button button--secondary" type="button" disabled={busy} onClick={() => void loadTab(tab)}>刷新</button>
      </header>

      <nav className="market-tabs" aria-label="真实资产工作台视图">
        {tabs.map((item) => (
          <button key={item.id} type="button" className={tab === item.id ? 'market-tabs__tab market-tabs__tab--active' : 'market-tabs__tab'} onClick={() => setTab(item.id)}>
            {item.label}
          </button>
        ))}
      </nav>

      {error ? <div className="screen-error" role="alert">{error}</div> : null}
      {notice ? <div className="screen-success" role="status">{notice}</div> : null}
      {busy ? <p>处理中，请稍候…</p> : null}
      {!overview ? <div className="app-loading" aria-label="加载资产数据"><span /><span /><span /></div> : null}

      {overview && tab === 'overview' ? (
        <>
          <div className="metric-grid">
            <div className="metric-card"><span>已授权角色</span><strong>{overview.totals.characters}</strong></div>
            <div className="metric-card"><span>最近同步</span><strong>{dateTime(latestSync)}</strong></div>
            <div className="metric-card"><span>资产物品行</span><strong>{num(overview.totals.items, 0)}</strong></div>
            <div className="metric-card"><span>完整快照角色</span><strong>{overview.totals.withSnapshot} / {overview.totals.characters}</strong></div>
            <div className="metric-card"><span>市场参考估值（估值快照）</span><strong>{num(marketReferenceTotal, 2)}</strong></div>
            <div className="metric-card"><span>买单深度可执行估值（估值快照）</span><strong>{num(liquidationTotal, 2)}</strong></div>
            <div className="metric-card"><span>估值快照未知物品</span><strong>{num(unknownItems, 0)}</strong></div>
            <div className="metric-card"><span>真实交易执行</span><strong>DISABLED</strong></div>
          </div>
          {staleValuationCharacters.length > 0 ? (
            <div className="support-note support-note--warn" role="status">
              <strong>估值快照已过期：</strong>{staleValuationSummary}市场参考和可执行估值不代表当前库存总值，请对最新资产快照重新执行估值。
            </div>
          ) : null}
          <p>不同估值口径分别展示，禁止相加形成虚假总资产。{overview.valuationNote}</p>
          <h2>分类库存（当前集）</h2>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>分类</th><th>物品行</th><th>总数量</th></tr></thead>
              <tbody>
                {selectedCharacter?.bucketSummary.map((row) => (
                  <tr key={row.bucket}><td>{row.labelZh}</td><td>{row.items}</td><td>{num(row.quantity, 0)}</td></tr>
                ))}
                {!selectedCharacter?.bucketSummary.length ? <tr><td colSpan={3}>尚无当前库存。</td></tr> : null}
              </tbody>
            </table>
          </div>
          <h2>角色同步与估值</h2>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>角色</th><th>当前物品</th><th>最近任务</th><th>完整快照</th><th>市场参考</th><th>可执行出售</th></tr></thead>
              <tbody>
                {characters.map((row) => (
                  <tr key={row.characterId}>
                    <td>{row.characterName || row.characterId}</td>
                    <td>{row.currentAssetItems}</td>
                    <td>{String(row.lastJob?.status ?? 'N/A')} · {dateTime(row.lastJob?.completedAt ?? row.lastJob?.completed_at)}</td>
                    <td>{row.latestSnapshot ? `${dateTime(row.latestSnapshot.completed_at)} · ${row.latestSnapshot.total_items} 行` : '无'}</td>
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
            <thead><tr><th>角色</th><th>角色 ID</th><th>同步状态</th><th>最后同步</th><th>物品数</th><th>估值摘要</th><th>操作</th></tr></thead>
            <tbody>
              {characters.map((row) => (
                <tr key={row.characterId}>
                  <td>{row.characterName || '未知角色'}</td>
                  <td>{row.characterId}</td>
                  <td>{String(row.lastJob?.status ?? (row.syncEnabled ? '待同步' : '自动同步关闭'))}</td>
                  <td>{dateTime(row.lastJob?.completedAt ?? row.lastJob?.completed_at ?? row.latestSnapshot?.completed_at)}</td>
                  <td>{row.currentAssetItems}</td>
                  <td>
                    参考 {num(row.latestValuation?.marketReferenceValue, 2)} ·
                    {' '}可执行 {num(row.latestValuation?.bidLiquidationNet, 2)}
                  </td>
                  <td><button type="button" disabled={busy} onClick={() => void syncCharacter(row.characterId)}>单独同步</button></td>
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
              placeholder="搜索名称或 Type ID"
              value={inventoryQuery.q}
              onChange={(event) => setInventoryQuery((current) => ({ ...current, q: event.target.value, offset: 0 }))}
            />
            <select
              className="market-select"
              value={inventoryQuery.bucket}
              onChange={(event) => setInventoryQuery((current) => ({ ...current, bucket: event.target.value, offset: 0 }))}
            >
              {BUCKETS.map((bucket) => <option key={bucket} value={bucket}>{bucket ? BUCKET_LABELS[bucket] : '全部分类'}</option>)}
            </select>
            <select
              className="market-select"
              value={inventoryQuery.tradable}
              onChange={(event) => setInventoryQuery((current) => ({ ...current, tradable: event.target.value, offset: 0 }))}
            >
              <option value="">全部交易状态</option>
              <option value="true">有市场订单</option>
              <option value="false">无市场订单</option>
            </select>
            <select
              className="market-select"
              value={`${inventoryQuery.sort}:${inventoryQuery.order}`}
              onChange={(event) => {
                const [sort, order] = event.target.value.split(':');
                setInventoryQuery((current) => ({ ...current, sort, order, offset: 0 }));
              }}
            >
              <option value="quantity:desc">数量从多到少</option>
              <option value="quantity:asc">数量从少到多</option>
              <option value="name:asc">名称 A→Z</option>
              <option value="type:asc">Type ID 升序</option>
            </select>
            <button type="button" disabled={busy} onClick={() => void loadInventory()}>查询</button>
          </div>
          <p>共 {inventory?.total ?? 0} 行；估值来自最近一次完成运行。</p>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>物品</th><th>数量</th><th>分类</th><th>位置</th><th>市场参考</th>
                  <th>可执行出售</th><th>估值状态</th><th>本地标签</th><th>操作</th>
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
                      {row.regionName || '区域 UNKNOWN'}<br />
                      <small>{row.solarSystemName || '星系 UNKNOWN'} · {row.resolvedName || row.resolvedType || '位置 UNKNOWN'} · {row.resolutionStatus}</small>
                    </td>
                    <td>{num(row.marketReferenceValue, 2)}</td>
                    <td>{num(row.bidLiquidationNet, 2)}</td>
                    <td>{row.valuationStatuses.length ? row.valuationStatuses.join(' / ') : '未估值'}</td>
                    <td>{row.tag ? TAG_LABELS[row.tag] || row.tag : '无'}</td>
                    <td><button type="button" onClick={() => void openItem(row.itemId)}>详情</button></td>
                  </tr>
                ))}
                {!inventory?.rows.length ? <tr><td colSpan={9}>没有匹配的库存。</td></tr> : null}
              </tbody>
            </table>
          </div>
          <div className="toolbar">
            <button
              type="button"
              disabled={busy || inventoryQuery.offset <= 0}
              onClick={() => setInventoryQuery((current) => ({ ...current, offset: Math.max(0, current.offset - current.limit) }))}
            >
              上一页
            </button>
            <span>第 {Math.floor(inventoryQuery.offset / inventoryQuery.limit) + 1} 页</span>
            <button
              type="button"
              disabled={busy || (inventory?.offset ?? 0) + (inventory?.limit ?? 0) >= (inventory?.total ?? 0)}
              onClick={() => setInventoryQuery((current) => ({ ...current, offset: current.offset + current.limit }))}
            >
              下一页
            </button>
          </div>
        </>
      ) : null}

      {tab === 'detail' ? (
        selectedItem ? (
          <>
            <div className="metric-grid">
              <div className="metric-card"><span>物品名称</span><strong>{selectedItem.typeNameZh || selectedItem.typeName}</strong></div>
              <div className="metric-card"><span>Type ID</span><strong>{selectedItem.typeId}</strong></div>
              <div className="metric-card"><span>Item ID</span><strong>{selectedItem.itemId}</strong></div>
              <div className="metric-card"><span>数量</span><strong>{num(selectedItem.quantity, 0)}</strong></div>
              <div className="metric-card"><span>分类</span><strong>{selectedItem.bucketLabelZh}</strong></div>
              <div className="metric-card"><span>市场参考</span><strong>{num(selectedItem.marketReferenceValue, 2)}</strong></div>
              <div className="metric-card"><span>买单深度可执行</span><strong>{num(selectedItem.bidLiquidationNet, 2)}</strong></div>
              <div className="metric-card"><span>本地标签</span><strong>{selectedItem.tag ? TAG_LABELS[selectedItem.tag] || selectedItem.tag : '无'}</strong></div>
            </div>
            <h2>位置与容器</h2>
            <p>
              {selectedItem.regionName || '区域 UNKNOWN'} · {selectedItem.solarSystemName || '星系 UNKNOWN'} ·
              {' '}{selectedItem.resolvedName || selectedItem.resolvedType || '位置 UNKNOWN'} ·
              {' '}{selectedItem.locationType || 'container UNKNOWN'} · {selectedItem.locationFlag || 'flag UNKNOWN'} ·
              {' '}{selectedItem.resolutionStatus || 'UNKNOWN'}
            </p>
            <h2>估值状态</h2>
            <p>{selectedItem.valuationStatuses?.length ? selectedItem.valuationStatuses.join(' / ') : '尚无完成估值'}</p>
            <h2>本地标签</h2>
            <div className="toolbar">
              <select
                className="market-select"
                value={selectedItem.tag ?? ''}
                onChange={(event) => void saveTag(selectedItem.itemId, event.target.value)}
              >
                <option value="">无标签</option>
                {Object.entries(TAG_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <button type="button" onClick={() => setTab('inventory')}>返回库存</button>
            </div>
            <h2>快照历史</h2>
            <div className="data-table-wrap">
              <table className="data-table">
                <thead><tr><th>快照</th><th>时间</th><th>数量</th><th>位置</th><th>状态</th></tr></thead>
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
                  {!selectedItem.snapshotHistory?.length ? <tr><td colSpan={5}>暂无快照历史。</td></tr> : null}
                </tbody>
              </table>
            </div>
            <h2>历史变化</h2>
            <div className="data-table-wrap">
              <table className="data-table">
                <thead><tr><th>变化</th><th>前数量</th><th>后数量</th><th>前位置</th><th>后位置</th><th>来源</th><th>时间</th></tr></thead>
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
                  {!selectedItem.changeHistory?.length ? <tr><td colSpan={7}>暂无观察变化。</td></tr> : null}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div className="workspace-empty">
            <h2>尚未选择物品</h2>
            <p>请先在库存列表中打开一个物品。</p>
            <button type="button" onClick={() => setTab('inventory')}>返回库存列表</button>
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
              <option value="">全部变化</option>
              {Object.entries(CHANGE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <label>从<input type="date" value={changeQuery.from} onChange={(event) => setChangeQuery((current) => ({ ...current, from: event.target.value }))} /></label>
            <label>到<input type="date" value={changeQuery.to} onChange={(event) => setChangeQuery((current) => ({ ...current, to: event.target.value }))} /></label>
            <button type="button" disabled={busy} onClick={() => void loadChanges()}>查询变化</button>
          </div>
          <p>共 {changeTotal} 条持久化观察变化；不推断购买、出售、损失等因果。</p>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>变化</th><th>物品</th><th>数量</th><th>位置变化</th><th>来源/置信度</th><th>快照</th><th>时间</th></tr></thead>
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
                {!changes.length ? <tr><td colSpan={7}>没有匹配的变化。</td></tr> : null}
              </tbody>
            </table>
          </div>

          <h2>对比两个完整快照</h2>
          <div className="toolbar">
            <select className="market-select" value={compareFrom} onChange={(event) => setCompareFrom(event.target.value)}>
              <option value="">起始快照</option>
              {snapshots.filter((row) => row.status === 'COMPLETED').map((row) => (
                <option key={row.snapshot_id} value={row.snapshot_id}>{dateTime(row.completed_at)} · {row.total_items} 行</option>
              ))}
            </select>
            <select className="market-select" value={compareTo} onChange={(event) => setCompareTo(event.target.value)}>
              <option value="">目标快照</option>
              {snapshots.filter((row) => row.status === 'COMPLETED').map((row) => (
                <option key={row.snapshot_id} value={row.snapshot_id}>{dateTime(row.completed_at)} · {row.total_items} 行</option>
              ))}
            </select>
            <button type="button" disabled={busy || !compareFrom || !compareTo || compareFrom === compareTo} onClick={() => void compareSnapshots()}>
              对比
            </button>
          </div>
          {compareResult ? (
            <>
              <p>
                对比摘要：
                {Object.entries(compareResult.summary ?? {})
                  .map(([key, value]) => `${CHANGE_LABELS[key] || key} ${value}`)
                  .join(' · ') || '无差异'}
              </p>
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead><tr><th>变化</th><th>Item ID</th><th>Type ID</th><th>前数量</th><th>后数量</th><th>前位置</th><th>后位置</th><th>来源</th></tr></thead>
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

          <h2>角色资产总量变化</h2>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>快照</th><th>完成时间</th><th>物品行</th><th>Δ物品</th><th>种类</th><th>位置</th><th>总数量</th><th>Δ数量</th></tr></thead>
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
                {!totalsHistory.length ? <tr><td colSpan={8}>暂无完整快照。</td></tr> : null}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === 'valuation' ? (
        <>
          <div className="toolbar">
            <button type="button" disabled={busy || characterId === null} onClick={() => void runValuation()}>执行最新快照估值</button>
            <span>
              费用模型：{valuations?.latestTotals?.feeModelVersion || '尚未运行'} ·
              {' '}行情快照：{dateTime(valuations?.latestTotals?.marketSnapshotAt)} ·
              {' '}资产快照：{valuations?.latestTotals?.snapshotId || 'N/A'} ·
              {' '}费用假设：{(valuations?.latestTotals?.feeAssumptions as any)?.note || '默认 Alpha 技能 / NPC 空间站'}
            </span>
          </div>
          {selectedCharacter?.valuationFreshness?.status === 'STALE' ? (
            <div className="support-note support-note--warn" role="status">
              <strong>当前估值不是最新资产快照：</strong>{selectedCharacter.valuationFreshness.message} 请使用“执行最新快照估值”生成新结果。
            </div>
          ) : null}
          <div className="metric-grid">
            <div className="metric-card"><span>市场参考估值（估值快照）</span><strong>{num(valuations?.latestTotals?.marketReferenceValue, 2)}</strong></div>
            <div className="metric-card"><span>买单深度可执行估值（估值快照）</span><strong>{num(valuations?.latestTotals?.bidLiquidationNet, 2)}</strong></div>
            <div className="metric-card"><span>卖单重置成本</span><strong>{num(valuations?.latestTotals?.askReplacementGross, 2)}</strong></div>
            <div className="metric-card"><span>历史成本</span><strong>UNKNOWN</strong></div>
            <div className="metric-card"><span>估值覆盖率</span><strong>{valuationCoverage === null ? 'N/A' : `${valuationCoverage.toFixed(2)}%`}</strong></div>
            <div className="metric-card"><span>估值快照未知物品</span><strong>{num(unknownValuation, 0)}</strong></div>
            <div className="metric-card"><span>深度不足物品</span><strong>{num(depthShortfall, 0)}</strong></div>
            <div className="metric-card"><span>估值物品总数</span><strong>{num(valuationRows.length, 0)}</strong></div>
          </div>
          <p>四个口径分别展示，绝不相加。历史成本保持 UNKNOWN，直到 P9.3 提供独立真实采购记录。</p>

          <h2>估值运行历史（不同贸易中心）</h2>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>估值 ID</th><th>地点</th><th>状态</th><th>创建时间</th><th>已估值</th><th>未知</th><th>费用版本</th></tr></thead>
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
                {!valuations?.runs?.length ? <tr><td colSpan={7}>尚无估值运行。</td></tr> : null}
              </tbody>
            </table>
          </div>

          <h2>最近一次估值明细</h2>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>物品</th><th>数量</th><th>市场参考</th><th>买单毛值</th><th>买单净额</th><th>可售/未售</th><th>卖单重置</th><th>状态</th></tr></thead>
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
                {!valuationRows.length ? <tr><td colSpan={8}>最近一次运行没有明细。</td></tr> : null}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === 'opportunities' ? (
        <>
          <div className="toolbar">
            <button type="button" disabled={busy || characterId === null} onClick={() => void recomputeMatches()}>
              重新计算库存联动
            </button>
            <span>共 {matches?.total ?? 0} 个活跃机会匹配；仅本地确定性计算，不生成真实订单。</span>
          </div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>机会</th><th>库存支持</th><th>持有/可用/需求</th><th>位置</th>
                  <th>运输</th><th>费用后利润</th><th>综合利润</th><th>数据质量</th>
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
                        <small>{row.strategy === 'station_arbitrage' ? '站内套利' : '跨贸易中心'} · {row.state}</small><br />
                        <small>{row.buy_location_name} → {row.sell_location_name}</small>
                      </td>
                      <td>{row.supportClassZh}<br /><small>{row.support_class}</small></td>
                      <td>{row.held_quantity} / {row.accessible_quantity} / {row.required_quantity}</td>
                      <td>
                        {locationRows.map((item) => (
                          <div key={String(item.terminalLocationId)}>
                            {item.locationName || `地点 ${item.terminalLocationId}`} · {item.quantity} · {item.resolutionStatus}
                            {item.atBuyHub ? ' · BUY HUB' : ''}
                          </div>
                        ))}
                        {!locationRows.length ? '无位置明细' : ''}
                      </td>
                      <td>{row.needs_transport ? '需要运输 / UNKNOWN' : '不需要'}</td>
                      <td>{num(row.fee_net_profit, 2)}</td>
                      <td>{row.comprehensive_net_profit == null ? row.comprehensive_status : num(row.comprehensive_net_profit, 2)}</td>
                      <td>
                        快照 {quality?.dataQuality?.snapshotId || 'UNKNOWN'}<br />
                        未知位置数量 {quality?.dataQuality?.unknownLocationQuantity ?? 'N/A'}<br />
                        已预留 {reservation?.reservation?.reservedByEarlierOpportunities ?? 0} ·
                        {' '}本机会分配 {reservation?.reservation?.allocatedToThisOpportunity ?? 0}
                      </td>
                    </tr>
                  );
                })}
                {!matches?.rows.length ? <tr><td colSpan={8}>暂无活跃机会联动结果。</td></tr> : null}
              </tbody>
            </table>
          </div>
          <p>跨贸易中心机会的运输成本仍为 UNKNOWN 时，综合利润保持 UNKNOWN；库存已在买入地点不等于运输已完成。</p>
        </>
      ) : null}
    </section>
  );
}
