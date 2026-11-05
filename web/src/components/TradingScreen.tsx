import { useCallback, useEffect, useState } from 'react';
import { webApi } from '../api';
import { LocaleSwitch, useI18n } from '../i18n';
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
  initialized?: boolean;
  message?: string;
  portfolio: { account: Record<string, unknown>; strategyBreakdown: Array<Record<string, unknown>> } | null;
  performance: Performance | null;
  runtime: Runtime | null;
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
  const { t } = useI18n();
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
      setError(reason instanceof Error ? reason.message : t('paperLoadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <div className="app-loading" aria-label={t('paperLoading')}><span /><span /><span /></div>;
  if (error) return <div className="screen-error" role="alert">{error}</div>;
  if (!overview) return <div className="screen-empty">{t('paperEmpty')}</div>;
  if (overview.initialized === false || !overview.performance || !overview.runtime) {
    return <div className="screen-empty">{overview.message || t('paperNotInitialized')}</div>;
  }

  const performance = overview.performance;
  const runtime = overview.runtime;
  const metricCards = [
    [t('paperTotalCost'), isk.format(performance.inventoryCost + performance.availableCash + performance.escrowLocked)],
    [t('paperAvailableCash'), isk.format(performance.availableCash)],
    [t('paperEscrowLocked'), isk.format(performance.escrowLocked)],
    [t('paperRealizedNet'), isk.format(performance.realizedNetPnl)],
    [t('paperUnrealizedPnl'), isk.format(performance.unrealizedPnl)],
    [t('paperNetReturn'), pctText(performance.netReturnPct)],
    [t('paperCapitalUtilization'), pctText(performance.capitalUtilizationPct)],
    [t('paperMaxDrawdown'), pctText(performance.maxDrawdownPct)],
  ];

  return (
    <section className="market-screen">
      <header className="market-screen__topbar">
        <button className="icon-button" type="button" onClick={onMenu} aria-label={t('openMenu')}><MenuIcon size={20} /></button>
        <h1><ChartIcon size={18} /> {t('paperTitle')}</h1>
        <span className={`status-pill${runtime.status === 'PAPER_TRADING_OPERATIONAL' ? '' : ' status-pill--warn'}`}>
          {runtime.status} · {performance.sampleStatus}
        </span>
        <LocaleSwitch />
        <button className="button button--secondary" type="button" onClick={() => void load()}>{t('refresh')}</button>
      </header>

      <nav className="market-tabs" aria-label={t('paperViewNav')}>
        {(['overview', 'opportunities', 'orders', 'performance', 'risk'] as const).map((key) => (
          <button key={key} type="button" className={tab === key ? 'market-tab market-tab--active' : 'market-tab'} onClick={() => setTab(key)}>
            {{ overview: t('paperTabOverview'), opportunities: t('paperTabOpportunities'), orders: t('paperTabOrders'), performance: t('paperTabPerformance'), risk: t('paperTabRisk') }[key]}
          </button>
        ))}
      </nav>

      {tab === 'overview' ? (
        <div className="metric-grid">
          {metricCards.map(([label, value]) => <div className="metric-card" key={label}><span>{label}</span><strong>{value}</strong></div>)}
          <div className="metric-card"><span>{t('paperOrderStatuses')}</span><strong>{JSON.stringify(runtime.counts.orderStatuses || {})}</strong></div>
          <div className="metric-card"><span>{t('paperAccountingStatus')}</span><strong>{performance.accounting.isReconciled ? t('paperAccountingReconciled') : t('paperAccountingDiff', { value: String(performance.accounting.discrepancy) })}</strong></div>
        </div>
      ) : null}

      {tab === 'opportunities' ? (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th>{t('colOpportunity')}</th><th>{t('colStrategy')}</th><th>{t('profileStatus')}</th><th>{t('colTheoreticalGross')}</th><th>{t('colExecutableGross')}</th><th>{t('colNetAfterFees')}</th><th>{t('colComprehensiveNet')}</th><th>{t('colRisk')}</th><th>{t('colDetectedAt')}</th></tr></thead>
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
            <thead><tr><th>{t('profileTabOrders')}</th><th>{t('marketAlertSide')}</th><th>{t('profileStatus')}</th><th>{t('colType')}</th><th>{t('marketPrice')}</th><th>{t('marketQuantity')}</th><th>{t('colFilled')}</th><th>{t('supportCost')}</th><th>{t('colCreatedAt')}</th></tr></thead>
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
            <thead><tr><th>{t('colStrategy')}</th><th>{t('colSample')}</th><th>{t('colSubmitted')}</th><th>{t('colTradeDone')}</th><th>{t('colCompleted')}</th><th>{t('colFillRate')}</th><th>{t('colNetPnl')}</th><th>{t('colNetReturnRate')}</th><th>{t('colDrawdown')}</th><th>{t('colUtilization')}</th><th>{t('colInventoryOverhang')}</th></tr></thead>
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
          <h2>{t('paperGatesTitle')}</h2>
          <table className="data-table">
            <thead><tr><th>{t('colGate')}</th><th>{t('profileStatus')}</th><th>{t('colDetail')}</th></tr></thead>
            <tbody>{runtime.gates.map((gate) => <tr key={gate.name}><td>{gate.name}</td><td>{gate.status}</td><td>{gate.detail}</td></tr>)}</tbody>
          </table>
          <h2>{t('paperRiskFlagsTitle')}</h2>
          <p>{performance.riskFlags.length ? performance.riskFlags.join(' · ') : t('none')}</p>
          <h2>{t('paperTraceabilityTitle')}</h2>
          <pre>{JSON.stringify(runtime.traceability, null, 2)}</pre>
        </div>
      ) : null}
    </section>
  );
}