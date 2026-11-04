import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { webApi } from '../api';

type Page = 'overview' | 'records' | 'costs' | 'pnl' | 'reconcile' | 'evidence' | 'audit';
type AnyRow = Record<string, any>;

const RECONCILE_PAGE_SIZE = 200;

const pageLabels: Record<Page, string> = {
  overview: '交易总览',
  records: '交易记录',
  costs: '库存成本',
  pnl: '盈亏分析',
  reconcile: '资产对账',
  evidence: '证据中心',
  audit: '审计中心',
};

const num = (value: unknown, digits = 2): string => typeof value === 'number' && Number.isFinite(value)
  ? value.toLocaleString('zh-CN', { maximumFractionDigits: digits })
  : 'N/A';
const dateTime = (value: unknown): string => {
  if (typeof value !== 'string' || !value) return 'N/A';
  const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN') : value;
};
const localInputToIso = (value: string, label: string): string => {
  const raw = value.trim();
  if (!raw) throw new Error(`${label}必填。`);
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label}格式无效。`);
  return date.toISOString();
};
const finiteNumber = (value: string, label: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label}必须是有限数值。`);
  return parsed;
};
const nonNegativeNumber = (value: string, label: string): number => {
  const parsed = finiteNumber(value, label);
  if (parsed < 0) throw new Error(`${label}不能为负数。`);
  return parsed;
};
const positiveInteger = (value: string, label: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label}必须是正整数。`);
  return parsed;
};

export function P93AccountingPanel({ csrfToken }: { csrfToken: string }) {
  const [page, setPage] = useState<Page>('overview');
  const [overview, setOverview] = useState<AnyRow | null>(null);
  const [records, setRecords] = useState<AnyRow[]>([]);
  const [costs, setCosts] = useState<AnyRow | null>(null);
  const [performance, setPerformance] = useState<AnyRow | null>(null);
  const [reconciliation, setReconciliation] = useState<AnyRow | null>(null);
  const [reconcileOffset, setReconcileOffset] = useState(0);
  const [evidence, setEvidence] = useState<AnyRow[]>([]);
  const [audit, setAudit] = useState<AnyRow | null>(null);
  const [selected, setSelected] = useState<AnyRow | null>(null);
  const [recordFilters, setRecordFilters] = useState({ state: '', verification: '', direction: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [recordForm, setRecordForm] = useState({
    ledgerKey: `manual-${Date.now()}`,
    tradeKind: 'BUY',
    direction: 'BUY',
    typeId: '34',
    locationId: '60003760',
    quantity: '1',
    unitPrice: '0',
    tradeTime: new Date().toISOString().slice(0, 16),
    sourceType: 'USER_MANUAL_ENTRY',
    feeStatus: 'UNKNOWN',
    notes: '',
    adjustmentMode: 'INCREASE',
    adjustmentAmount: '',
    targetLotId: '',
    fromLocationId: '',
    toLocationId: '',
  });
  const [evidenceForm, setEvidenceForm] = useState({
    evidenceType: 'USER_CONFIRMATION',
    sourceSystem: 'USER',
    sourceRef: '',
    capturedAt: new Date().toISOString().slice(0, 16),
    payloadHash: '',
    summary: '',
    status: 'PENDING',
  });
  const [evidenceLink, setEvidenceLink] = useState({ evidenceId: '', relation: 'PRIMARY' });
  const [correctionForm, setCorrectionForm] = useState({ ledgerKey: '', quantity: '', unitPrice: '', tradeTime: '', reason: '' });

  const load = useCallback(async (activePage: Page = page, offset = reconcileOffset) => {
    setBusy(true);
    setError(null);
    try {
      const requests: Array<Promise<unknown>> = [webApi.p93.overview()];
      if (activePage === 'records') requests.push(webApi.p93.records({ ...recordFilters, limit: 300 }));
      if (activePage === 'costs') requests.push(webApi.p93.costs());
      if (activePage === 'pnl') requests.push(webApi.p93.performance());
      if (activePage === 'reconcile') requests.push(webApi.p93.reconciliation({ limit: RECONCILE_PAGE_SIZE, offset }));
      if (activePage === 'evidence') requests.push(webApi.p93.evidenceList());
      if (activePage === 'audit') requests.push(webApi.p93.audit());
      const results = await Promise.all(requests);
      setOverview(results[0] as AnyRow);
      if (activePage === 'records') setRecords(((results[1] as AnyRow)?.records || []) as AnyRow[]);
      if (activePage === 'costs') setCosts(results[1] as AnyRow);
      if (activePage === 'pnl') setPerformance(results[1] as AnyRow);
      if (activePage === 'reconcile') setReconciliation(((results[1] as AnyRow)?.reconciliation || null) as AnyRow | null);
      if (activePage === 'evidence') setEvidence(((results[1] as AnyRow)?.evidence || []) as AnyRow[]);
      if (activePage === 'audit') setAudit(results[1] as AnyRow);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'REAL 账本数据加载失败。');
    } finally {
      setBusy(false);
    }
  }, [page, recordFilters, reconcileOffset]);

  useEffect(() => { void load(page, reconcileOffset); }, [page, reconcileOffset, load]);

  const action = async (run: () => Promise<unknown>, message: string, reloadOffset?: number) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await run();
      setNotice(message);
      await load(page, reloadOffset);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作失败。');
    } finally {
      setBusy(false);
    }
  };

  const createRecord = () => action(async () => {
    const isCostAdjustment = recordForm.tradeKind === 'COST_ADJUSTMENT';
    const isTransfer = recordForm.tradeKind === 'INVENTORY_TRANSFER';
    if (isCostAdjustment && (!recordForm.targetLotId.trim() || !recordForm.adjustmentAmount.trim())) {
      throw new Error('成本调整必须填写目标批次和调整金额。');
    }
    if (isTransfer && (!recordForm.fromLocationId.trim() || !recordForm.toLocationId.trim())) {
      throw new Error('库存转移必须填写调出和调入地点。');
    }
    const fromLocationId = isTransfer ? positiveInteger(recordForm.fromLocationId, '调出地点') : undefined;
    const toLocationId = isTransfer ? positiveInteger(recordForm.toLocationId, '调入地点') : undefined;
    if (isTransfer && fromLocationId === toLocationId) throw new Error('库存转移的调出和调入地点不能相同。');
    await webApi.p93.createRecord({
      ...recordForm,
      typeId: positiveInteger(recordForm.typeId, 'Type ID'),
      locationId: positiveInteger(recordForm.locationId, '地点 ID'),
      quantity: isCostAdjustment ? 0 : positiveInteger(recordForm.quantity, '数量'),
      unitPrice: nonNegativeNumber(recordForm.unitPrice, '单价'),
      tradeTime: localInputToIso(recordForm.tradeTime, '成交时间'),
      adjustmentAmount: isCostAdjustment ? nonNegativeNumber(recordForm.adjustmentAmount, '调整金额') : undefined,
      targetLotId: isCostAdjustment ? recordForm.targetLotId.trim() : undefined,
      fromLocationId,
      toLocationId,
      draft: true,
    }, csrfToken);
    setRecordForm((current) => ({ ...current, ledgerKey: `manual-${Date.now()}` }));
  }, 'REAL 交易草稿已登记；必须关联证据并人工核实后才进入 FIFO。');

  const openRecord = (recordId: string) => action(async () => {
    const [record, evidencePayload] = await Promise.all([
      webApi.p93.record(recordId) as Promise<AnyRow>,
      webApi.p93.evidenceList() as Promise<AnyRow>,
    ]);
    const fact = record.record as AnyRow | undefined;
    if (!fact?.recordId) throw new Error('交易详情缺失，请刷新后重试。');
    setSelected(record);
    setEvidence((evidencePayload.evidence || []) as AnyRow[]);
    setCorrectionForm({
      ledgerKey: `correction-${Date.now()}`,
      quantity: String(fact.quantity),
      unitPrice: String(fact.unitPrice),
      tradeTime: String(fact.tradeTime).slice(0, 16),
      reason: '',
    });
  }, '交易详情已加载。');

  const createEvidence = () => action(async () => {
    await webApi.p93.evidence({
      ...evidenceForm,
      sourceRef: evidenceForm.sourceRef || undefined,
      capturedAt: localInputToIso(evidenceForm.capturedAt, '证据采集时间'),
    }, csrfToken);
  }, '证据已登记。');

  const linkSelectedEvidence = () => action(async () => {
    if (!selected?.record?.recordId || !evidenceLink.evidenceId) throw new Error('请选择交易和证据。');
    await webApi.p93.linkEvidence(selected.record.recordId, {
      evidenceId: evidenceLink.evidenceId,
      relation: evidenceLink.relation,
      confidence: 'HIGH',
    }, csrfToken);
    setSelected(await webApi.p93.record(selected.record.recordId) as AnyRow);
  }, '证据已关联到交易。');

  const correctSelectedRecord = () => action(async () => {
    const fact = selected?.record as AnyRow | undefined;
    if (!fact?.recordId) throw new Error('请先打开要更正的交易。');
    if (!correctionForm.reason.trim()) throw new Error('更正必须填写原因。');
    if (!correctionForm.ledgerKey.trim()) throw new Error('更正必须使用新的幂等编号。');
    await webApi.p93.correctRecord(fact.recordId, {
      reason: correctionForm.reason,
      record: {
        ...fact,
        ledgerKey: correctionForm.ledgerKey.trim(),
        quantity: fact.tradeKind === 'COST_ADJUSTMENT' ? 0 : positiveInteger(correctionForm.quantity, '更正数量'),
        unitPrice: nonNegativeNumber(correctionForm.unitPrice, '更正单价'),
        tradeTime: localInputToIso(correctionForm.tradeTime, '更正时间'),
        sourceHash: undefined,
        draft: true,
      },
    }, csrfToken);
    setSelected(null);
  }, '更正记录已创建；原记录保留并标记为 CORRECTED。');

  const metric = (label: string, value: ReactNode) => (
    <div className="metric-card"><span>{label}</span><strong>{value}</strong></div>
  );

  return (
    <section className="screen-section" aria-busy={busy}>
      <div className="section-heading">
        <div>
          <h2>P9.3 真实交易账本与成本核算</h2>
          <p>只记录可核实事实；用户申报、UNKNOWN 成本、资产变化不会自动进入已核实盈亏。</p>
        </div>
        <span className="status-pill">REAL_ACCOUNTING · AI 只读 · ESI GET-only</span>
      </div>
      <nav className="market-tabs market-tabs--scroll" aria-label="P9.3 真实账本页面">
        {(Object.keys(pageLabels) as Page[]).map((item) => (
          <button key={item} type="button" className={page === item ? 'active' : ''} aria-current={page === item ? 'page' : undefined} onClick={() => setPage(item)}>{pageLabels[item]}</button>
        ))}
      </nav>
      {error ? <p className="screen-error" role="alert">{error}</p> : null}
      {notice ? <p className="screen-notice" role="status" aria-live="polite">{notice}</p> : null}

      {page === 'overview' ? (
        <div>
          <div className="metric-grid">
            {metric('REAL 交易记录', num(overview?.summary?.rawRecordCount, 0))}
            {metric('已实现盈亏', num(overview?.performance?.realizedPnl))}
            {metric('未实现盈亏', num(overview?.performance?.unrealizedPnl))}
            {metric('库存成本', num(overview?.performance?.inventoryCost))}
            {metric('资金占用', num(overview?.performance?.capitalOccupied))}
            {metric('UNKNOWN 成本项', num(overview?.performance?.unknownCostCount, 0))}
          </div>
          <div className="toolbar">
            <button type="button" disabled={busy} onClick={() => void action(() => webApi.p93.syncEsiWallet(csrfToken), 'ESI 钱包成交证据同步完成。')}>同步 ESI 钱包成交</button>
            <button type="button" disabled={busy} onClick={() => void action(() => webApi.p93.recalculate(csrfToken), 'FIFO 历史重算完成。')}>重算 FIFO / 盈亏</button>
            <button type="button" disabled={busy} onClick={() => void action(() => webApi.p93.runReconciliation(csrfToken), '真实资产对账完成。')}>执行资产对账</button>
          </div>
          <p>估值口径相互独立：市场参考价值不是实际可变现价值；买单清算、卖单重置分别列示。</p>
        </div>
      ) : null}

      {page === 'records' ? (
        <div>
          <h3>筛选交易记录</h3>
          <div className="form-grid">
            <label>记录状态
              <select value={recordFilters.state} onChange={(event) => setRecordFilters((v) => ({ ...v, state: event.target.value }))}>
                <option value="">全部</option><option value="DRAFT">草稿</option><option value="ACTIVE">活动</option>
                <option value="VERIFIED">已核实</option><option value="REJECTED">已驳回</option>
                <option value="REVERSED">已冲正</option><option value="CORRECTED">已更正</option>
              </select>
            </label>
            <label>核实等级
              <select value={recordFilters.verification} onChange={(event) => setRecordFilters((v) => ({ ...v, verification: event.target.value }))}>
                <option value="">全部</option><option value="VERIFIED">已核实</option><option value="USER_REPORTED">用户申报</option>
                <option value="PENDING">待核实</option><option value="CONFLICT">存在冲突</option><option value="REJECTED">已驳回</option>
              </select>
            </label>
            <label>方向
              <select value={recordFilters.direction} onChange={(event) => setRecordFilters((v) => ({ ...v, direction: event.target.value }))}>
                <option value="">全部</option><option value="BUY">买入</option><option value="SELL">卖出</option><option value="NONE">非买卖</option>
              </select>
            </label>
          </div>
          <h3>登记真实成交或调整</h3>
          <div className="form-grid">
            <label>幂等编号<input value={recordForm.ledgerKey} onChange={(event) => setRecordForm((v) => ({ ...v, ledgerKey: event.target.value }))} /></label>
            <label>类型
              <select value={recordForm.tradeKind} onChange={(event) => {
                const tradeKind = event.target.value;
                setRecordForm((v) => ({
                  ...v,
                  tradeKind,
                  direction: tradeKind === 'COST_ADJUSTMENT' || tradeKind === 'INVENTORY_TRANSFER' ? 'NONE' : v.direction === 'NONE' ? 'BUY' : v.direction,
                  quantity: tradeKind === 'COST_ADJUSTMENT'
                    ? '0'
                    : tradeKind === 'INVENTORY_TRANSFER' && Number(v.quantity) <= 0 ? '1' : v.quantity,
                  unitPrice: tradeKind === 'COST_ADJUSTMENT' || tradeKind === 'INVENTORY_TRANSFER' ? '0' : v.unitPrice,
                }));
              }}>
                <option value="BUY">买入</option><option value="SELL">卖出</option><option value="PARTIAL_FILL">部分成交</option>
                <option value="MULTI_BATCH_FILL">多批次成交</option><option value="COST_ADJUSTMENT">成本调整</option><option value="INVENTORY_TRANSFER">库存转移</option>
              </select>
            </label>
            <label>方向
              <select value={recordForm.direction} onChange={(event) => setRecordForm((v) => ({ ...v, direction: event.target.value }))}>
                <option value="BUY">买入</option><option value="SELL">卖出</option><option value="NONE">非买卖</option>
              </select>
            </label>
            <label>Type ID<input value={recordForm.typeId} onChange={(event) => setRecordForm((v) => ({ ...v, typeId: event.target.value }))} /></label>
            <label>地点 ID<input value={recordForm.locationId} onChange={(event) => setRecordForm((v) => ({ ...v, locationId: event.target.value }))} /></label>
            <label>数量<input value={recordForm.quantity} onChange={(event) => setRecordForm((v) => ({ ...v, quantity: event.target.value }))} /></label>
            <label>单价<input value={recordForm.unitPrice} onChange={(event) => setRecordForm((v) => ({ ...v, unitPrice: event.target.value }))} /></label>
            <label>成交时间<input type="datetime-local" value={recordForm.tradeTime} onChange={(event) => setRecordForm((v) => ({ ...v, tradeTime: event.target.value }))} /></label>
            <label>数据来源<input value={recordForm.sourceType} onChange={(event) => setRecordForm((v) => ({ ...v, sourceType: event.target.value }))} /></label>
            <label>费用完整性
              <select value={recordForm.feeStatus} onChange={(event) => setRecordForm((v) => ({ ...v, feeStatus: event.target.value }))}>
                <option value="UNKNOWN">未知</option><option value="COMPLETE">完整</option>
              </select>
            </label>
            <label>备注<input value={recordForm.notes} onChange={(event) => setRecordForm((v) => ({ ...v, notes: event.target.value }))} /></label>
            {recordForm.tradeKind === 'COST_ADJUSTMENT' ? (
              <>
                <label>目标批次<input value={recordForm.targetLotId} onChange={(event) => setRecordForm((v) => ({ ...v, targetLotId: event.target.value }))} placeholder="LOT-..." /></label>
                <label>调整方向
                  <select value={recordForm.adjustmentMode} onChange={(event) => setRecordForm((v) => ({ ...v, adjustmentMode: event.target.value }))}>
                    <option value="INCREASE">增加成本</option><option value="DECREASE">减少成本</option>
                  </select>
                </label>
                <label>调整金额<input value={recordForm.adjustmentAmount} onChange={(event) => setRecordForm((v) => ({ ...v, adjustmentAmount: event.target.value }))} /></label>
              </>
            ) : null}
            {recordForm.tradeKind === 'INVENTORY_TRANSFER' ? (
              <>
                <label>调出地点 ID<input value={recordForm.fromLocationId} onChange={(event) => setRecordForm((v) => ({ ...v, fromLocationId: event.target.value }))} /></label>
                <label>调入地点 ID<input value={recordForm.toLocationId} onChange={(event) => setRecordForm((v) => ({ ...v, toLocationId: event.target.value }))} /></label>
              </>
            ) : null}
          </div>
          <div className="toolbar"><button type="button" disabled={busy} onClick={() => void createRecord()}>保存为待核实草稿</button></div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>时间</th><th>方向/类型</th><th>物品/地点</th><th>数量/价格</th><th>核实状态</th><th>操作</th></tr></thead>
            <tbody>{records.map((row) => (
              <tr key={row.recordId}>
                <td>{dateTime(row.tradeTime)}</td><td>{row.direction} / {row.tradeKind}</td>
                <td>{row.typeId} @ {row.locationId}</td><td>{num(row.quantity, 0)} × {num(row.unitPrice)}</td>
                <td>{row.verificationStatus} / {row.recordState}</td>
                <td>
                  <button type="button" onClick={() => void openRecord(row.recordId)}>详情</button>
                  <button type="button" disabled={busy || row.recordState !== 'DRAFT'} onClick={() => void action(() => webApi.p93.recordAction(row.recordId, 'submit', csrfToken), '草稿已提交为待核实申报。')}>提交申报</button>
                  <button type="button" disabled={busy || row.recordState !== 'ACTIVE' || row.verificationStatus === 'VERIFIED'} onClick={() => void action(() => webApi.p93.recordAction(row.recordId, 'verify', csrfToken), '交易已核实。')}>核实</button>
                  <button type="button" disabled={busy || ['VERIFIED', 'REJECTED', 'REVERSED', 'CORRECTED'].includes(row.recordState)} onClick={() => void action(() => webApi.p93.recordAction(row.recordId, 'reject', csrfToken, '人工驳回'), '交易已驳回。')}>驳回</button>
                  <button type="button" disabled={busy || !['ACTIVE', 'VERIFIED'].includes(row.recordState)} onClick={() => void action(() => webApi.p93.recordAction(row.recordId, 'reverse', csrfToken, '人工冲正'), '交易已冲正。')}>冲正</button>
                </td>
              </tr>
              ))}</tbody>
            </table>
          </div>
          {selected ? (
            <div className="detail-panel">
              <h3>交易详情：{selected.record?.recordId}</h3>
              <p>
                状态：{selected.record?.verificationStatus} / {selected.record?.recordState}；
                类型：{selected.record?.direction} / {selected.record?.tradeKind}；
                数量：{num(selected.record?.quantity, 0)}；单价：{num(selected.record?.unitPrice)}
              </p>
              <h4>关联证据</h4>
              <div className="form-grid">
                <label>证据
                  <select value={evidenceLink.evidenceId} onChange={(event) => setEvidenceLink((v) => ({ ...v, evidenceId: event.target.value }))}>
                    <option value="">请选择</option>
                    {evidence.map((row) => (
                      <option key={row.evidence_id} value={row.evidence_id}>{row.evidence_type} · {row.status} · {row.source_ref || row.evidence_id}</option>
                    ))}
                  </select>
                </label>
                <label>关系
                  <select value={evidenceLink.relation} onChange={(event) => setEvidenceLink((v) => ({ ...v, relation: event.target.value }))}>
                    <option value="PRIMARY">主证据</option><option value="CORROBORATING">佐证</option>
                    <option value="CONFLICTING">冲突</option><option value="ADJUSTMENT">调整依据</option>
                  </select>
                </label>
              </div>
              <div className="toolbar"><button type="button" disabled={busy || !evidenceLink.evidenceId || ['VERIFIED', 'REVERSED', 'CORRECTED'].includes(selected.record?.recordState)} onClick={() => void linkSelectedEvidence()}>关联到当前交易</button></div>
              <h4>发起更正</h4>
              <p>更正是新建一条草稿并保留原记录，不能复用原幂等编号或原地覆盖事实。</p>
              <div className="form-grid">
                <label>新幂等编号<input value={correctionForm.ledgerKey} onChange={(event) => setCorrectionForm((v) => ({ ...v, ledgerKey: event.target.value }))} /></label>
                <label>更正数量<input value={correctionForm.quantity} onChange={(event) => setCorrectionForm((v) => ({ ...v, quantity: event.target.value }))} /></label>
                <label>更正单价<input value={correctionForm.unitPrice} onChange={(event) => setCorrectionForm((v) => ({ ...v, unitPrice: event.target.value }))} /></label>
                <label>更正时间<input type="datetime-local" value={correctionForm.tradeTime} onChange={(event) => setCorrectionForm((v) => ({ ...v, tradeTime: event.target.value }))} /></label>
                <label>更正原因<input value={correctionForm.reason} onChange={(event) => setCorrectionForm((v) => ({ ...v, reason: event.target.value }))} /></label>
              </div>
              <div className="toolbar"><button type="button" disabled={busy || !['ACTIVE', 'VERIFIED'].includes(selected.record?.recordState)} onClick={() => void correctSelectedRecord()}>创建更正草稿</button></div>
              <details><summary>原始详情与审计事件</summary><pre>{JSON.stringify(selected, null, 2)}</pre></details>
            </div>
          ) : null}
        </div>
      ) : null}

      {page === 'costs' ? (
        <div>
          <h3>FIFO 成本批次</h3>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>批次</th><th>物品/地点</th><th>原始/剩余</th><th>单位成本</th><th>剩余成本</th><th>成本状态</th></tr></thead>
            <tbody>{(costs?.lots || []).map((row: AnyRow) => (
              <tr key={row.lot_id}><td>{row.lot_id}</td><td>{row.type_id} @ {row.location_id}</td>
                <td>{num(row.original_quantity, 0)} / {num(row.remaining_quantity, 0)}</td>
                <td>{num(row.unit_cost)}</td><td>{num(row.remaining_cost)}</td><td>{row.cost_status}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      ) : null}

      {page === 'pnl' ? (
        <div>
          <div className="metric-grid">
            {metric('已实现盈亏', num(performance?.performance?.realizedPnl))}
            {metric('未实现盈亏', num(performance?.performance?.unrealizedPnl))}
            {metric('总交易费用', num(performance?.performance?.totalFees))}
            {metric('累计买入', num(performance?.performance?.cumulativeBuyAmount))}
            {metric('累计卖出', num(performance?.performance?.cumulativeSellAmount))}
            {metric('平均持仓天数', num(performance?.performance?.averageHoldingDays))}
          </div>
          <h3>未实现盈亏估值口径</h3>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>口径</th><th>估值</th><th>库存成本</th><th>未实现盈亏</th><th>状态</th></tr></thead>
            <tbody>{Object.entries(performance?.unrealized?.perspectives || {}).map(([key, value]: [string, any]) => (
              <tr key={key}><td>{value.label}</td><td>{num(value.valuation)}</td><td>{num(value.costBasis)}</td><td>{num(value.unrealizedPnl)}</td><td>{value.status}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      ) : null}

      {page === 'reconcile' ? (
        <div>
          {(() => {
            const items = Array.isArray(reconciliation?.items) ? reconciliation.items as AnyRow[] : [];
            const pagination = reconciliation?.pagination || {};
            const itemTotal = Math.max(0, Number(pagination.itemTotal) || 0);
            const caseTotal = Math.max(0, Number(pagination.caseTotal) || 0);
            const pageStart = itemTotal === 0 ? 0 : reconcileOffset + 1;
            const pageEnd = Math.min(reconcileOffset + items.length, itemTotal);
            return (
              <>
                <div className="toolbar">
                  <button type="button" disabled={busy} onClick={() => {
                    setReconcileOffset(0);
                    void action(() => webApi.p93.runReconciliation(csrfToken), '资产对账已重新执行。', 0);
                  }}>执行资产对账</button>
                  <button type="button" disabled={busy || reconcileOffset === 0} onClick={() => setReconcileOffset(Math.max(0, reconcileOffset - RECONCILE_PAGE_SIZE))}>上一页</button>
                  <button type="button" disabled={busy || reconcileOffset + RECONCILE_PAGE_SIZE >= itemTotal} onClick={() => setReconcileOffset(reconcileOffset + RECONCILE_PAGE_SIZE)}>下一页</button>
                  <span role="status" aria-live="polite">显示 {pageStart}-{pageEnd} / 共 {itemTotal.toLocaleString('zh-CN')} 条差异；复核案例 {caseTotal.toLocaleString('zh-CN')} 条</span>
                </div>
                {reconciliation ? (
                  <>
                    <p>对账状态：<strong>{reconciliation.run?.status}</strong>；资产变化只会生成人工复核案例，不会自动生成已核实交易。</p>
                    <div className="data-table-wrap">
                      <table className="data-table">
                        <thead><tr><th>物品/地点</th><th>账本数量</th><th>资产数量</th><th>差异</th><th>状态</th><th>原因</th></tr></thead>
                        <tbody>{items.length ? items.map((row: AnyRow) => (
                          <tr key={row.reconcile_key}><td>{row.reconcile_key}</td><td>{num(row.ledger_quantity, 0)}</td><td>{num(row.asset_quantity, 0)}</td>
                            <td>{num(row.delta_quantity, 0)}</td><td>{row.status}</td><td>{row.reason}</td></tr>
                        )) : <tr><td colSpan={6} className="data-table__empty">此页没有资产对账差异。</td></tr>}</tbody>
                      </table>
                    </div>
                  </>
                ) : <p className="screen-empty">尚未执行资产对账。</p>}
              </>
            );
          })()}
        </div>
      ) : null}

      {page === 'evidence' ? (
        <div>
          <h3>登记证据</h3>
          <div className="form-grid">
            <label>证据类型
              <select value={evidenceForm.evidenceType} onChange={(event) => setEvidenceForm((v) => ({ ...v, evidenceType: event.target.value }))}>
                <option value="USER_ATTACHMENT">人工凭证</option><option value="USER_CONFIRMATION">用户确认</option>
              </select>
            </label>
            <label>来源系统<input value={evidenceForm.sourceSystem} onChange={(event) => setEvidenceForm((v) => ({ ...v, sourceSystem: event.target.value }))} /></label>
            <label>来源引用<input value={evidenceForm.sourceRef} onChange={(event) => setEvidenceForm((v) => ({ ...v, sourceRef: event.target.value }))} /></label>
            <label>采集时间<input type="datetime-local" value={evidenceForm.capturedAt} onChange={(event) => setEvidenceForm((v) => ({ ...v, capturedAt: event.target.value }))} /></label>
            <label>内容哈希<input value={evidenceForm.payloadHash} onChange={(event) => setEvidenceForm((v) => ({ ...v, payloadHash: event.target.value }))} /></label>
            <label>摘要<input value={evidenceForm.summary} onChange={(event) => setEvidenceForm((v) => ({ ...v, summary: event.target.value }))} /></label>
          </div>
          <p>新证据固定以 PENDING 登记；必须单独执行“核实证据”，再回到交易记录执行人工核实。</p>
          <div className="toolbar"><button type="button" disabled={busy} onClick={() => void createEvidence()}>登记证据</button></div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>采集时间</th><th>类型</th><th>来源</th><th>状态</th><th>摘要</th><th>操作</th></tr></thead>
            <tbody>{evidence.map((row) => (
              <tr key={row.evidence_id}>
                <td>{dateTime(row.captured_at)}</td><td>{row.evidence_type}</td><td>{row.source_system} / {row.source_ref || '-'}</td>
                <td>{row.status}</td><td>{row.summary || '-'}</td>
                <td>
                  <button type="button" disabled={busy || row.status === 'VERIFIED'} onClick={() => void action(() => webApi.p93.evidenceStatus(row.evidence_id, 'VERIFIED', csrfToken), '证据已核实。')}>核实证据</button>
                  <button type="button" disabled={busy || row.status === 'REJECTED'} onClick={() => void action(() => webApi.p93.evidenceStatus(row.evidence_id, 'REJECTED', csrfToken, '人工驳回'), '证据已驳回。')}>驳回证据</button>
                </td>
              </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      ) : null}

      {page === 'audit' ? (
        <div>
          <p>完整性：{audit?.integrity?.ok ? '通过' : '存在异常'}；原始事件只追加，已核实记录不能直接删除。</p>
          <h3>核算版本</h3>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>版本</th><th>时间</th><th>状态</th><th>已实现已知盈亏</th><th>未知成本</th><th>差异</th></tr></thead>
            <tbody>{(audit?.calculationRuns || []).map((row: AnyRow) => (
              <tr key={row.run_id}><td>{row.calculation_version}</td><td>{dateTime(row.completed_at || row.started_at)}</td><td>{row.status}</td><td>{num(row.realized_pnl)}</td><td>{num(row.unknown_cost_count, 0)}</td><td><pre>{JSON.stringify(row.differences)}</pre></td></tr>
              ))}</tbody>
            </table>
          </div>
          <h3>审计事件</h3>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>时间</th><th>记录</th><th>事件</th><th>操作者</th><th>原因</th></tr></thead>
            <tbody>{(audit?.events || []).map((row: AnyRow) => (
              <tr key={row.event_id}><td>{dateTime(row.created_at)}</td><td>{row.record_id}</td><td>{row.event_type}</td><td>{row.actor_type}/{row.actor_id}</td><td>{row.reason || '-'}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
}
