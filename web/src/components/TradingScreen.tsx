import { useCallback, useEffect, useState } from 'react';
import { webApi } from '../api';
import { ChartIcon, MenuIcon } from '../icons';

type StrategyMetric = {
  strategy: string;
  sampleStatus: string;
  submittedOrders: number;
  filledOrders: number;
  completedTrades: number;
  fillRatePct: number | null;
  realizedNetPnl: number;
  netReturnPct: number | null;
  maxDrawdownPct: number | null;
  capitalUtilizationPct: number | null;
  inventoryOverhang: number;
};

type Performance = {
  sampleStatus: string;
  initialCapital: number;
  availableCash: number;
  escrowLocked: number;
  inventoryCost: number;
  inventoryMarketValue: number;
  realizedGrossPnl: number;
  feesPaid: number;
  realizedNetPnl: number;
  unrealizedPnl: number;
  netPnl: number;
  netReturnPct: number | null;
  capitalUtilizationPct: number | null;
  fillRatePct: number | null;
  opportunityRealizationRatePct: number | null;
  maxDrawdownPct: number | null;
  strategyMetrics: StrategyMetric[];
  riskFlags: string[];
  accounting: { isReconciled: boolean; discrepancy: number };
};

type Runtime = {
  status: string;
  sampleStatus: string;
  counts: Record<string, unknown>;
  gates: Array<{ name: string; status: string; detail: string }>;
  traceability: Record<string, number>;
};

type Overview = {
  portfolio: { account: Record<string, unknown>; strategyBreakdown: Array<Record<string, unknown>> };
  performance: Performance;
  runtime: Runtime;
};

type OrderRow = Record<string, unknown> & {
  order_id: string;
  order_type: string;
  status: string;
  type_id: number;
  price: number;
  quantity: number;
  filled_quantity: number;
  fees_paid: number;
  created_at: string;
};

type OpportunityRow = Record<string, unknown> & {
  opportunity_id: string;
  strategy_type: string;
  type_id: number;
  outcome_status: string;
  risk_rating: string;
  expected_net_profit: number;
  theoretical_gross_profit: number | null;
  executable_gross_profit: number | null;
  comprehensive_net_profit: number | null;
  comprehensive_net_profit_status: string;
  detected_at: string;
};

const isk = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const pctText = (value: number | null | undefined) => value == null ? 'N/A' : `${value.toFixed(2)}%`;

type Props = { onMenu: () => void };

/** 数据全部来自 Paper Trading API；没有前端静态模拟数据。 */
export function TradingScreen({ onMenu }: Props) {
  const [tab, setTab] = useState<'overview' | 'opportunities' | 'orders' | 'performance' | 'risk'>('overview');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [opportunities, setOpportunities] = useState<OpportunityRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [overviewPayload, ordersPayload, opportunitiesPayload] = await Promise.all([
        webApi.trading.overview(),
        webApi.trading.orders(undefined, 200),
        webApi.trading.opportunities(200),
      ]);
      setOverview(overviewPayload as Overview);
      setOrders(((ordersPayload as { orders?: OrderRow[] }).orders || []) as OrderRow[]);
      setOpportunities(((opportunitiesPayload as { opportunities?: OpportunityRow[] }).opportunities || []) as OpportunityRow[]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Paper Trading 数据加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <div className="app-loading" aria-label="加载 Paper Trading"><span /><span /><span /></div>;
  if (error) return <div className="screen-error" role="alert">{error}</div>;
  if (!overview) return <div className="screen-empty">暂无 Paper Trading 数据</div>;

  const performance = overview.performance;
  const runtime = overview.runtime;
  const metricCards = [
    ['总资产（成本）', isk.format(performance.inventoryCost + performance.availableCash + performance.escrowLocked)],
    ['可用现金', isk.format(performance.availableCash)],
    ['冻结资金', isk.format(performance.escrowLocked)],
    ['已实现净盈亏', isk.format(performance.realizedNetPnl)],
    ['未实现盈亏', isk.format(performance.unrealizedPnl)],
    ['净收益率', pctText(performance.netReturnPct)],
    ['资金利用率', pctText(performance.capitalUtilizationPct)],
    ['最大回撤', pctText(performance.maxDrawdownPct)],
  ];

  return (
    <section className="market-screen">
      <header className="market-screen__topbar">
        <button className="icon-button" type="button" onClick={onMenu} aria-label="打开菜单"><MenuIcon size={20} /></button>
        <h1><ChartIcon size={18} /> Paper Trading 分析</h1>
        <span className={`status-pill${runtime.status === 'PAPER_TRADING_OPERATIONAL' ? '' : ' status-pill--warn'}`}>
          {runtime.status} · {performance.sampleStatus}
        </span>
        <button className="button button--secondary" type="button" onClick={() => void load()}>刷新</button>
      </header>

      <nav className="market-tabs" aria-label="Paper Trading 视图">
        {(['overview', 'opportunities', 'orders', 'performance', 'risk'] as const).map((key) => (
          <button key={key} type="button" className={tab === key ? 'market-tab market-tab--active' : 'market-tab'} onClick={() => setTab(key)}>
            {{ overview: '总览', opportunities: '机会中心', orders: '模拟订单', performance: '策略绩效', risk: '风险面板' }[key]}
          </button>
        ))}
      </nav>

      {tab === 'overview' ? (
        <div className="metric-grid">
          {metricCards.map(([label, value]) => <div className="metric-card" key={label}><span>{label}</span><strong>{value}</strong></div>)}
          <div className="metric-card"><span>订单状态</span><strong>{JSON.stringify(runtime.counts.orderStatuses || {})}</strong></div>
          <div className="metric-card"><span>账本状态</span><strong>{performance.accounting.isReconciled ? '已对平' : `差异 ${performance.accounting.discrepancy}`}</strong></div>
        </div>
      ) : null}

      {tab === 'opportunities' ? (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th>机会</th><th>策略</th><th>状态</th><th>理论毛利</th><th>可执行毛利</th><th>费用后净利</th><th>综合净利</th><th>风险</th><th>发现时间</th></tr></thead>
            <tbody>
              {opportunities.map((row) => (
                <tr key={row.opportunity_id}>
                  <td>{row.opportunity_id}</td><td>{row.strategy_type}</td><td>{row.outcome_status}</td>
                  <td>{row.theoretical_gross_profit == null ? 'UNKNOWN' : isk.format(row.theoretical_gross_profit)}</td>
                  <td>{row.executable_gross_profit == null ? 'UNKNOWN' : isk.format(row.executable_gross_profit)}</td>
                  <td>{isk.format(row.expected_net_profit)}</td>
                  <td>{row.comprehensive_net_profit == null ? row.comprehensive_net_profit_status : isk.format(row.comprehensive_net_profit)}</td>
                  <td>{row.risk_rating}</td><td>{row.detected_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {tab === 'orders' ? (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th>订单</th><th>方向</th><th>状态</th><th>类型</th><th>价格</th><th>数量</th><th>已成交</th><th>费用</th><th>创建时间</th></tr></thead>
            <tbody>
              {orders.map((row) => (
                <tr key={row.order_id}>
                  <td>{row.order_id}</td><td>{row.order_type}</td><td>{row.status}</td><td>{row.type_id}</td>
                  <td>{isk.format(Number(row.price))}</td><td>{row.quantity}</td><td>{row.filled_quantity}</td>
                  <td>{isk.format(Number(row.fees_paid))}</td><td>{row.created_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {tab === 'performance' ? (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th>策略</th><th>样本</th><th>提交</th><th>成交</th><th>完成</th><th>成交率</th><th>净盈亏</th><th>净收益率</th><th>回撤</th><th>利用率</th><th>库存占用</th></tr></thead>
            <tbody>
              {performance.strategyMetrics.map((row) => (
                <tr key={row.strategy}>
                  <td>{row.strategy}</td><td>{row.sampleStatus}</td><td>{row.submittedOrders}</td><td>{row.filledOrders}</td>
                  <td>{row.completedTrades}</td><td>{pctText(row.fillRatePct)}</td><td>{isk.format(row.realizedNetPnl)}</td>
                  <td>{pctText(row.netReturnPct)}</td><td>{pctText(row.maxDrawdownPct)}</td>
                  <td>{pctText(row.capitalUtilizationPct)}</td><td>{isk.format(row.inventoryOverhang)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {tab === 'risk' ? (
        <div className="data-table-wrap">
          <h2>运行门禁</h2>
          <table className="data-table">
            <thead><tr><th>门禁</th><th>状态</th><th>说明</th></tr></thead>
            <tbody>{runtime.gates.map((gate) => <tr key={gate.name}><td>{gate.name}</td><td>{gate.status}</td><td>{gate.detail}</td></tr>)}</tbody>
          </table>
          <h2>风险标记</h2>
          <p>{performance.riskFlags.length ? performance.riskFlags.join(' · ') : '无'}</p>
          <h2>可追溯链</h2>
          <pre>{JSON.stringify(runtime.traceability, null, 2)}</pre>
        </div>
      ) : null}
    </section>
  );
}