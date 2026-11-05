import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { webApi } from '../api';
import { useI18n, type TranslationKey } from '../i18n';
import { readStoredLocale } from '../i18n-dictionary';
import { formatP93Number, freshnessPresentation } from '../p93-freshness';

type Page = 'overview' | 'records' | 'costs' | 'pnl' | 'reconcile' | 'evidence' | 'audit';
type AnyRow = Record<string, any>;

const RECONCILE_PAGE_SIZE = 200;

type Translate = (key: TranslationKey, params?: Record<string, string>) => string;

const pageLabels = (t: Translate): Record<Page, string> => ({
  overview: t('p93TabOverview'),
  records: t('p93TabRecords'),
  costs: t('p93TabCosts'),
  pnl: t('p93TabPnl'),
  reconcile: t('p93TabReconcile'),
  evidence: t('p93TabEvidence'),
  audit: t('p93TabAudit'),
});

const num = formatP93Number;
const dateTime = (value: unknown): string => {
  if (typeof value !== 'string' || !value) return 'N/A';
  const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(
        readStoredLocale() === 'zh' ? 'zh-CN' : readStoredLocale() === 'ru' ? 'ru-RU' : 'en-US',
      )
    : value;
};
const localInputToIso = (value: string, label: string, t: Translate): string => {
  const raw = value.trim();
  if (!raw) throw new Error(t('validationRequired', { value: label }));
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) throw new Error(t('validationInvalidFormat', { value: label }));
  return date.toISOString();
};
const finiteNumber = (value: string, label: string, t: Translate): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(t('validationFiniteNumber', { value: label }));
  return parsed;
};
const nonNegativeNumber = (value: string, label: string, t: Translate): number => {
  const parsed = finiteNumber(value, label, t);
  if (parsed < 0) throw new Error(t('validationNotNegative', { value: label }));
  return parsed;
};
const positiveInteger = (value: string, label: string, t: Translate): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(t('validationPositiveInteger', { value: label }));
  return parsed;
};

export function P93AccountingPanel({ csrfToken }: { csrfToken: string }) {
  const { t, locale } = useI18n();
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
      setError(reason instanceof Error ? reason.message : t('p93LoadFailed'));
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
      setError(reason instanceof Error ? reason.message : t('p93ActionFailed'));
    } finally {
      setBusy(false);
    }
  };

  const createRecord = () => action(async () => {
    const isCostAdjustment = recordForm.tradeKind === 'COST_ADJUSTMENT';
    const isTransfer = recordForm.tradeKind === 'INVENTORY_TRANSFER';
    if (isCostAdjustment && (!recordForm.targetLotId.trim() || !recordForm.adjustmentAmount.trim())) {
      throw new Error(t('p93CostAdjNeedsTarget'));
    }
    if (isTransfer && (!recordForm.fromLocationId.trim() || !recordForm.toLocationId.trim())) {
      throw new Error(t('p93TransferNeedsLocations'));
    }
    const fromLocationId = isTransfer ? positiveInteger(recordForm.fromLocationId, t('p93SourceLocation'), t) : undefined;
    const toLocationId = isTransfer ? positiveInteger(recordForm.toLocationId, t('p93TargetLocation'), t) : undefined;
    if (isTransfer && fromLocationId === toLocationId) throw new Error(t('p93TransferSameLocation'));
    await webApi.p93.createRecord({
      ...recordForm,
      typeId: positiveInteger(recordForm.typeId, 'Type ID', t),
      locationId: positiveInteger(recordForm.locationId, t('colLocationId'), t),
      quantity: isCostAdjustment ? 0 : positiveInteger(recordForm.quantity, t('marketQuantity'), t),
      unitPrice: nonNegativeNumber(recordForm.unitPrice, t('profileUnitPrice'), t),
      tradeTime: localInputToIso(recordForm.tradeTime, t('colTradeTime'), t),
      adjustmentAmount: isCostAdjustment ? nonNegativeNumber(recordForm.adjustmentAmount, t('p93AdjustAmount'), t) : undefined,
      targetLotId: isCostAdjustment ? recordForm.targetLotId.trim() : undefined,
      fromLocationId,
      toLocationId,
      draft: true,
    }, csrfToken);
    setRecordForm((current) => ({ ...current, ledgerKey: `manual-${Date.now()}` }));
  }, t('p93DraftRegistered'));

  const openRecord = (recordId: string) => action(async () => {
    const [record, evidencePayload] = await Promise.all([
      webApi.p93.record(recordId) as Promise<AnyRow>,
      webApi.p93.evidenceList() as Promise<AnyRow>,
    ]);
    const fact = record.record as AnyRow | undefined;
    if (!fact?.recordId) throw new Error(t('p93DetailMissing'));
    setSelected(record);
    setEvidence((evidencePayload.evidence || []) as AnyRow[]);
    setCorrectionForm({
      ledgerKey: `correction-${Date.now()}`,
      quantity: String(fact.quantity),
      unitPrice: String(fact.unitPrice),
      tradeTime: String(fact.tradeTime).slice(0, 16),
      reason: '',
    });
  }, t('p93DetailLoaded'));

  const createEvidence = () => action(async () => {
    await webApi.p93.evidence({
      ...evidenceForm,
      sourceRef: evidenceForm.sourceRef || undefined,
      capturedAt: localInputToIso(evidenceForm.capturedAt, t('p93EvidenceCapturedAt'), t),
    }, csrfToken);
  }, t('p93EvidenceRegistered'));

  const linkSelectedEvidence = () => action(async () => {
    if (!selected?.record?.recordId || !evidenceLink.evidenceId) throw new Error(t('p93PickTradeAndEvidence'));
    await webApi.p93.linkEvidence(selected.record.recordId, {
      evidenceId: evidenceLink.evidenceId,
      relation: evidenceLink.relation,
      confidence: 'HIGH',
    }, csrfToken);
    setSelected(await webApi.p93.record(selected.record.recordId) as AnyRow);
  }, t('p93EvidenceLinked'));

  const correctSelectedRecord = () => action(async () => {
    const fact = selected?.record as AnyRow | undefined;
    if (!fact?.recordId) throw new Error(t('p93OpenTradeFirst'));
    if (!correctionForm.reason.trim()) throw new Error(t('p93CorrectionNeedsReason'));
    if (!correctionForm.ledgerKey.trim()) throw new Error(t('p93CorrectionNeedsNewKey'));
    await webApi.p93.correctRecord(fact.recordId, {
      reason: correctionForm.reason,
      record: {
        ...fact,
        ledgerKey: correctionForm.ledgerKey.trim(),
        quantity: fact.tradeKind === 'COST_ADJUSTMENT' ? 0 : positiveInteger(correctionForm.quantity, t('p93CorrectionQuantity'), t),
        unitPrice: nonNegativeNumber(correctionForm.unitPrice, t('p93CorrectionPrice'), t),
        tradeTime: localInputToIso(correctionForm.tradeTime, t('p93CorrectionTime'), t),
        sourceHash: undefined,
        draft: true,
      },
    }, csrfToken);
    setSelected(null);
  }, t('p93CorrectionCreated'));

  const metric = (label: string, value: ReactNode) => (
    <div className="metric-card"><span>{label}</span><strong>{value}</strong></div>
  );

  return (
    <section className="screen-section" aria-busy={busy}>
      <div className="section-heading">
        <div>
          <h2>{t('p93Title')}</h2>
          <p>{t('p93Lead')}</p>
        </div>
        <span className="status-pill">{t('p93ModePill')}</span>
      </div>
      <nav className="market-tabs market-tabs--scroll" aria-label={t('p93Aria')}>
        {(Object.keys(pageLabels) as Page[]).map((item) => (
          <button key={item} type="button" className={page === item ? 'active' : ''} aria-current={page === item ? 'page' : undefined} onClick={() => setPage(item)}>{pageLabels(t)[item]}</button>
        ))}
      </nav>
      {error ? <p className="screen-error" role="alert">{error}</p> : null}
      {notice ? <p className="screen-notice" role="status" aria-live="polite">{notice}</p> : null}

      {page === 'overview' ? (
        <div>
          <div className="metric-grid">
            {metric(t('p93RecordsTitle'), num(overview?.summary?.rawRecordCount, 0))}
            {metric(t('colCalcStatus'), freshnessPresentation(overview?.performance?.freshness, t).status)}
            {metric(t('colRealizedCertain'), num(overview?.performance?.realizedPnl))}
            {metric(t('colKnownPartial'), num(overview?.performance?.knownRealizedPnl))}
            {metric(t('paperUnrealizedPnl'), num(overview?.performance?.unrealizedPnl))}
            {metric(t('p93TabCosts'), num(overview?.performance?.inventoryCost))}
            {metric(t('p93CapitalTied'), num(overview?.performance?.capitalOccupied))}
            {metric(t('p93UnknownCostItems'), num(overview?.performance?.unknownCostCount, 0))}
          </div>
          {freshnessPresentation(overview?.performance?.freshness, t).warning ? (
            <p className="screen-warning" role="status">
              {freshnessPresentation(overview?.performance?.freshness, t).warning}
            </p>
          ) : null}
          <div className="toolbar">
            <button type="button" disabled={busy} onClick={() => void action(() => webApi.p93.syncEsiWallet(csrfToken), t('p93WalletSyncDone'))}>{t('p93SyncWalletTrades')}</button>
            <button type="button" disabled={busy} onClick={() => void action(() => webApi.p93.recalculate(csrfToken), t('p93FifoRecalcDone'))}>{t('p93RecalcFifo')}</button>
            <button type="button" disabled={busy} onClick={() => void action(() => webApi.p93.runReconciliation(csrfToken), t('p93ReconcileDone'))}>{t('p93RunReconcile')}</button>
          </div>
          <p>{t('p93ValuationNote')}</p>
        </div>
      ) : null}

      {page === 'records' ? (
        <div>
          <h3>{t('p93FilterRecords')}</h3>
          <div className="form-grid">
            <label>{t('p93LabelRecordState')}
              <select value={recordFilters.state} onChange={(event) => setRecordFilters((v) => ({ ...v, state: event.target.value }))}>
                <option value="">{t('marketChartRangeAll')}</option><option value="DRAFT">{t('p93StatusDraft')}</option><option value="ACTIVE">{t('p93StatusActive')}</option>
                <option value="VERIFIED">{t('p93StatusVerified')}</option><option value="REJECTED">{t('p93StatusRejected')}</option>
                <option value="REVERSED">{t('p93StatusReversed')}</option><option value="CORRECTED">{t('p93StatusCorrected')}</option>
              </select>
            </label>
            <label>{t('p93LabelVerification')}
              <select value={recordFilters.verification} onChange={(event) => setRecordFilters((v) => ({ ...v, verification: event.target.value }))}>
                <option value="">{t('marketChartRangeAll')}</option><option value="VERIFIED">{t('p93StatusVerified')}</option><option value="USER_REPORTED">{t('p93StatusClaimed')}</option>
                <option value="PENDING">{t('p93StatusPending')}</option><option value="CONFLICT">{t('p93StatusConflict')}</option><option value="REJECTED">{t('p93StatusRejected')}</option>
              </select>
            </label>
            <label>{t('marketAlertSide')}
              <select value={recordFilters.direction} onChange={(event) => setRecordFilters((v) => ({ ...v, direction: event.target.value }))}>
                <option value="">{t('marketChartRangeAll')}</option><option value="BUY">{t('marketBuySide')}</option><option value="SELL">{t('marketSellSide')}</option><option value="NONE">{t('p93TypeNonTrade')}</option>
              </select>
            </label>
          </div>
          <h3>{t('p93RecordTrade')}</h3>
          <div className="form-grid">
            <label>{t('p93IdempotencyKey')}<input value={recordForm.ledgerKey} onChange={(event) => setRecordForm((v) => ({ ...v, ledgerKey: event.target.value }))} /></label>
            <label>{t('colType')}
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
                <option value="BUY">{t('marketBuySide')}</option><option value="SELL">{t('marketSellSide')}</option><option value="PARTIAL_FILL">{t('p93TypePartial')}</option>
                <option value="MULTI_BATCH_FILL">{t('p93TypeMultiBatch')}</option><option value="COST_ADJUSTMENT">{t('p93TypeCostAdjust')}</option><option value="INVENTORY_TRANSFER">{t('p93TypeTransfer')}</option>
              </select>
            </label>
            <label>{t('marketAlertSide')}
              <select value={recordForm.direction} onChange={(event) => setRecordForm((v) => ({ ...v, direction: event.target.value }))}>
                <option value="BUY">{t('marketBuySide')}</option><option value="SELL">{t('marketSellSide')}</option><option value="NONE">{t('p93TypeNonTrade')}</option>
              </select>
            </label>
            <label>Type ID<input value={recordForm.typeId} onChange={(event) => setRecordForm((v) => ({ ...v, typeId: event.target.value }))} /></label>
            <label>{t('colLocationId')}<input value={recordForm.locationId} onChange={(event) => setRecordForm((v) => ({ ...v, locationId: event.target.value }))} /></label>
            <label>{t('marketQuantity')}<input value={recordForm.quantity} onChange={(event) => setRecordForm((v) => ({ ...v, quantity: event.target.value }))} /></label>
            <label>{t('profileUnitPrice')}<input value={recordForm.unitPrice} onChange={(event) => setRecordForm((v) => ({ ...v, unitPrice: event.target.value }))} /></label>
            <label>{t('colTradeTime')}<input type="datetime-local" value={recordForm.tradeTime} onChange={(event) => setRecordForm((v) => ({ ...v, tradeTime: event.target.value }))} /></label>
            <label>{t('colDataSource')}<input value={recordForm.sourceType} onChange={(event) => setRecordForm((v) => ({ ...v, sourceType: event.target.value }))} /></label>
            <label>{t('p93LabelFeeCompleteness')}
              <select value={recordForm.feeStatus} onChange={(event) => setRecordForm((v) => ({ ...v, feeStatus: event.target.value }))}>
                <option value="UNKNOWN">{t('supportCostUnknownShort')}</option><option value="COMPLETE">{t('p93SourceComplete')}</option>
              </select>
            </label>
            <label>{t('colNote')}<input value={recordForm.notes} onChange={(event) => setRecordForm((v) => ({ ...v, notes: event.target.value }))} /></label>
            {recordForm.tradeKind === 'COST_ADJUSTMENT' ? (
              <>
                <label>{t('p93TargetBatch')}<input value={recordForm.targetLotId} onChange={(event) => setRecordForm((v) => ({ ...v, targetLotId: event.target.value }))} placeholder="LOT-..." /></label>
                <label>{t('p93LabelAdjustDirection')}
                  <select value={recordForm.adjustmentMode} onChange={(event) => setRecordForm((v) => ({ ...v, adjustmentMode: event.target.value }))}>
                    <option value="INCREASE">{t('p93CostIncrease')}</option><option value="DECREASE">{t('p93CostDecrease')}</option>
                  </select>
                </label>
                <label>{t('p93AdjustAmount')}<input value={recordForm.adjustmentAmount} onChange={(event) => setRecordForm((v) => ({ ...v, adjustmentAmount: event.target.value }))} /></label>
              </>
            ) : null}
            {recordForm.tradeKind === 'INVENTORY_TRANSFER' ? (
              <>
                <label>{t('p93SourceLocationId')}<input value={recordForm.fromLocationId} onChange={(event) => setRecordForm((v) => ({ ...v, fromLocationId: event.target.value }))} /></label>
                <label>{t('p93TargetLocationId')}<input value={recordForm.toLocationId} onChange={(event) => setRecordForm((v) => ({ ...v, toLocationId: event.target.value }))} /></label>
              </>
            ) : null}
          </div>
          <div className="toolbar"><button type="button" disabled={busy} onClick={() => void createRecord()}>{t('p93SaveDraft')}</button></div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>{t('colTime')}</th><th>{t('colDirectionType')}</th><th>{t('colItemLocation')}</th><th>{t('colQuantityPrice')}</th><th>{t('colVerificationStatus')}</th><th>{t('colAction')}</th></tr></thead>
            <tbody>{records.map((row) => (
              <tr key={row.recordId}>
                <td>{dateTime(row.tradeTime)}</td><td>{row.direction} / {row.tradeKind}</td>
                <td>{row.typeId} @ {row.locationId}</td><td>{num(row.quantity, 0)} × {num(row.unitPrice)}</td>
                <td>{row.verificationStatus} / {row.recordState}</td>
                <td>
                  <button type="button" onClick={() => void openRecord(row.recordId)}>{t('p93Detail')}</button>
                  <button type="button" disabled={busy || row.recordState !== 'DRAFT'} onClick={() => void action(() => webApi.p93.recordAction(row.recordId, 'submit', csrfToken), t('p93DraftSubmitted'))}>{t('p93SubmitClaim')}</button>
                  <button type="button" disabled={busy || row.recordState !== 'ACTIVE' || row.verificationStatus === 'VERIFIED'} onClick={() => void action(() => webApi.p93.recordAction(row.recordId, 'verify', csrfToken), t('p93TradeVerified'))}>{t('p93Verify')}</button>
                  <button type="button" disabled={busy || ['VERIFIED', 'REJECTED', 'REVERSED', 'CORRECTED'].includes(row.recordState)} onClick={() => void action(() => webApi.p93.recordAction(row.recordId, 'reject', csrfToken, t('p93RejectManually')), t('p93TradeRejected'))}>{t('p93Reject')}</button>
                  <button type="button" disabled={busy || !['ACTIVE', 'VERIFIED'].includes(row.recordState)} onClick={() => void action(() => webApi.p93.recordAction(row.recordId, 'reverse', csrfToken, t('p93ReverseManually')), t('p93TradeReversed'))}>{t('p93Reverse')}</button>
                </td>
              </tr>
              ))}</tbody>
            </table>
          </div>
          {selected ? (
            <div className="detail-panel">
              <h3>{t('p93DetailTitle')}{selected.record?.recordId}</h3>
              <p>
                {t('p93DetailStatusLine', { a: selected.record?.verificationStatus ?? '', b: selected.record?.recordState ?? '' })}
                {t('p93DetailTypeLine', { a: selected.record?.direction ?? '', b: selected.record?.tradeKind ?? '' })}
                {t('p93DetailQtyLine', { a: num(selected.record?.quantity, 0), b: num(selected.record?.unitPrice) })}
              </p>
              <h4>{t('p93LinkEvidence')}</h4>
              <div className="form-grid">
                <label>{t('p93LabelEvidence')}
                  <select value={evidenceLink.evidenceId} onChange={(event) => setEvidenceLink((v) => ({ ...v, evidenceId: event.target.value }))}>
                    <option value="">{t('p93SelectPlaceholder')}</option>
                    {evidence.map((row) => (
                      <option key={row.evidence_id} value={row.evidence_id}>{row.evidence_type} · {row.status} · {row.source_ref || row.evidence_id}</option>
                    ))}
                  </select>
                </label>
                <label>{t('p93LabelRelation')}
                  <select value={evidenceLink.relation} onChange={(event) => setEvidenceLink((v) => ({ ...v, relation: event.target.value }))}>
                    <option value="PRIMARY">{t('p93EvidencePrimary')}</option><option value="CORROBORATING">{t('p93EvidenceSupporting')}</option>
                    <option value="CONFLICTING">{t('p93EvidenceConflict')}</option><option value="ADJUSTMENT">{t('p93EvidenceAdjustBasis')}</option>
                  </select>
                </label>
              </div>
              <div className="toolbar"><button type="button" disabled={busy || !evidenceLink.evidenceId || ['VERIFIED', 'REVERSED', 'CORRECTED'].includes(selected.record?.recordState)} onClick={() => void linkSelectedEvidence()}>{t('p93LinkToCurrent')}</button></div>
              <h4>{t('p93StartCorrection')}</h4>
              <p>{t('p93CorrectionHelp')}</p>
              <div className="form-grid">
                <label>{t('p93NewIdempotencyKey')}<input value={correctionForm.ledgerKey} onChange={(event) => setCorrectionForm((v) => ({ ...v, ledgerKey: event.target.value }))} /></label>
                <label>{t('p93CorrectionQuantity')}<input value={correctionForm.quantity} onChange={(event) => setCorrectionForm((v) => ({ ...v, quantity: event.target.value }))} /></label>
                <label>{t('p93CorrectionPrice')}<input value={correctionForm.unitPrice} onChange={(event) => setCorrectionForm((v) => ({ ...v, unitPrice: event.target.value }))} /></label>
                <label>{t('p93CorrectionTime')}<input type="datetime-local" value={correctionForm.tradeTime} onChange={(event) => setCorrectionForm((v) => ({ ...v, tradeTime: event.target.value }))} /></label>
                <label>{t('p93CorrectionReason')}<input value={correctionForm.reason} onChange={(event) => setCorrectionForm((v) => ({ ...v, reason: event.target.value }))} /></label>
              </div>
              <div className="toolbar"><button type="button" disabled={busy || !['ACTIVE', 'VERIFIED'].includes(selected.record?.recordState)} onClick={() => void correctSelectedRecord()}>{t('p93CreateCorrection')}</button></div>
              <details><summary>{t('p93OriginalAndAudit')}</summary><pre>{JSON.stringify(selected, null, 2)}</pre></details>
            </div>
          ) : null}
        </div>
      ) : null}

      {page === 'costs' ? (
        <div>
          <h3>{t('p93FifoBatches')}</h3>
          <div className="metric-grid">
            {metric(t('colCalcStatus'), freshnessPresentation(costs?.freshness, t).status)}
          </div>
          {freshnessPresentation(costs?.freshness, t).warning ? (
            <p className="screen-warning" role="status">
              {freshnessPresentation(costs?.freshness, t).warning}
            </p>
          ) : null}
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>{t('colBatch')}</th><th>{t('colItemLocation')}</th><th>{t('colOriginalRemaining')}</th><th>{t('colUnitCost')}</th><th>{t('colRemainingCost')}</th><th>{t('colCostStatus')}</th></tr></thead>
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
            {metric(t('colCalcStatus'), freshnessPresentation(performance?.performance?.freshness, t).status)}
            {metric(t('colRealizedCertain'), num(performance?.performance?.realizedPnl))}
            {metric(t('colKnownPartial'), num(performance?.performance?.knownRealizedPnl))}
            {metric(t('paperUnrealizedPnl'), num(performance?.performance?.unrealizedPnl))}
            {metric(t('p93TotalFees'), num(performance?.performance?.totalFees))}
            {metric(t('p93CumulativeBuy'), num(performance?.performance?.cumulativeBuyAmount))}
            {metric(t('p93CumulativeSell'), num(performance?.performance?.cumulativeSellAmount))}
            {metric(t('p93AvgHoldingDays'), num(performance?.performance?.averageHoldingDays))}
            {metric(t('p93CertainSells'), num(performance?.performance?.deterministicSellCount, 0))}
            {metric(t('p93UnknownCostSells'), num(performance?.performance?.unknownCostSellCount, 0))}
            {metric(t('p93UnsoldUnknown'), num(performance?.performance?.unknownOpenLotCount, 0))}
          </div>
          {freshnessPresentation(performance?.performance?.freshness, t).warning ? (
            <p className="screen-warning" role="status">
              {freshnessPresentation(performance?.performance?.freshness, t).warning}
            </p>
          ) : null}
          <h3>{t('p93UnrealisedBasis')}</h3>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>{t('colBasis')}</th><th>{t('profileEstValue')}</th><th>{t('p93TabCosts')}</th><th>{t('paperUnrealizedPnl')}</th><th>{t('profileStatus')}</th></tr></thead>
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
                    void action(() => webApi.p93.runReconciliation(csrfToken), t('p93ReconcileRerun'), 0);
                  }}>{t('p93RunReconcile')}</button>
                  <button type="button" disabled={busy || reconcileOffset === 0} onClick={() => setReconcileOffset(Math.max(0, reconcileOffset - RECONCILE_PAGE_SIZE))}>{t('p93PrevPage')}</button>
                  <button type="button" disabled={busy || reconcileOffset + RECONCILE_PAGE_SIZE >= itemTotal} onClick={() => setReconcileOffset(reconcileOffset + RECONCILE_PAGE_SIZE)}>{t('p93NextPage')}</button>
                  <span role="status" aria-live="polite">{t('p93ReconcileCountLine', { start: String(pageStart), end: String(pageEnd), total: itemTotal.toLocaleString(locale === 'zh' ? 'zh-CN' : locale === 'ru' ? 'ru-RU' : 'en-US'), cases: caseTotal.toLocaleString(locale === 'zh' ? 'zh-CN' : locale === 'ru' ? 'ru-RU' : 'en-US') })}</span>
                </div>
                {reconciliation ? (
                  <>
                    <p>{t('p93ReconcileStatusLabel')}<strong>{reconciliation.run?.status}</strong>{t('p93ReconcileStatusSuffix')}</p>
                    <div className="data-table-wrap">
                      <table className="data-table">
                        <thead><tr><th>{t('colItemLocation')}</th><th>{t('p93LedgerQty')}</th><th>{t('p93AssetQty')}</th><th>{t('colDifference')}</th><th>{t('profileStatus')}</th><th>{t('colReason')}</th></tr></thead>
                        <tbody>{items.length ? items.map((row: AnyRow) => (
                          <tr key={row.reconcile_key}><td>{row.reconcile_key}</td><td>{num(row.ledger_quantity, 0)}</td><td>{num(row.asset_quantity, 0)}</td>
                            <td>{num(row.delta_quantity, 0)}</td><td>{row.status}</td><td>{row.reason}</td></tr>
                        )) : <tr><td colSpan={6} className="data-table__empty">{t('p93NoReconcileDiff')}</td></tr>}</tbody>
                      </table>
                    </div>
                  </>
                ) : <p className="screen-empty">{t('p93ReconcileNeverRun')}</p>}
              </>
            );
          })()}
        </div>
      ) : null}

      {page === 'evidence' ? (
        <div>
          <h3>{t('p93RecordEvidence')}</h3>
          <div className="form-grid">
            <label>{t('p93LabelEvidenceType')}
              <select value={evidenceForm.evidenceType} onChange={(event) => setEvidenceForm((v) => ({ ...v, evidenceType: event.target.value }))}>
                <option value="USER_ATTACHMENT">{t('p93EvidenceManual')}</option><option value="USER_CONFIRMATION">{t('p93EvidenceUserConfirm')}</option>
              </select>
            </label>
            <label>{t('colSourceSystem')}<input value={evidenceForm.sourceSystem} onChange={(event) => setEvidenceForm((v) => ({ ...v, sourceSystem: event.target.value }))} /></label>
            <label>{t('colSourceRef')}<input value={evidenceForm.sourceRef} onChange={(event) => setEvidenceForm((v) => ({ ...v, sourceRef: event.target.value }))} /></label>
            <label>{t('colCapturedAt')}<input type="datetime-local" value={evidenceForm.capturedAt} onChange={(event) => setEvidenceForm((v) => ({ ...v, capturedAt: event.target.value }))} /></label>
            <label>{t('colContentHash')}<input value={evidenceForm.payloadHash} onChange={(event) => setEvidenceForm((v) => ({ ...v, payloadHash: event.target.value }))} /></label>
            <label>{t('colSummary')}<input value={evidenceForm.summary} onChange={(event) => setEvidenceForm((v) => ({ ...v, summary: event.target.value }))} /></label>
          </div>
          <p>{t('p93EvidencePendingNote')}</p>
          <div className="toolbar"><button type="button" disabled={busy} onClick={() => void createEvidence()}>{t('p93RecordEvidence')}</button></div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>{t('colCapturedAt')}</th><th>{t('colType')}</th><th>{t('colSource')}</th><th>{t('profileStatus')}</th><th>{t('colSummary')}</th><th>{t('colAction')}</th></tr></thead>
            <tbody>{evidence.map((row) => (
              <tr key={row.evidence_id}>
                <td>{dateTime(row.captured_at)}</td><td>{row.evidence_type}</td><td>{row.source_system} / {row.source_ref || '-'}</td>
                <td>{row.status}</td><td>{row.summary || '-'}</td>
                <td>
                  <button type="button" disabled={busy || row.status === 'VERIFIED'} onClick={() => void action(() => webApi.p93.evidenceStatus(row.evidence_id, 'VERIFIED', csrfToken), t('p93EvidenceVerified'))}>{t('p93VerifyEvidence')}</button>
                  <button type="button" disabled={busy || row.status === 'REJECTED'} onClick={() => void action(() => webApi.p93.evidenceStatus(row.evidence_id, 'REJECTED', csrfToken, t('p93RejectManually')), t('p93EvidenceRejected'))}>{t('p93RejectEvidence')}</button>
                </td>
              </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      ) : null}

      {page === 'audit' ? (
        <div>
          <p>{t('p93IntegrityLabel')}{audit?.integrity?.ok ? t('p93Pass') : t('p93Anomaly')}{t('p93AuditAppendOnly')}</p>
          <h3>{t('p93AccountingVersion')}</h3>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>{t('colVersion')}</th><th>{t('colTime')}</th><th>{t('profileStatus')}</th><th>{t('p93RealisedKnown')}</th><th>{t('p93UnknownCost')}</th><th>{t('colDifference')}</th></tr></thead>
            <tbody>{(audit?.calculationRuns || []).map((row: AnyRow) => (
              <tr key={row.run_id}><td>{row.calculation_version}</td><td>{dateTime(row.completed_at || row.started_at)}</td><td>{row.status}</td><td>{num(row.realized_pnl)}</td><td>{num(row.unknown_cost_count, 0)}</td><td><pre>{JSON.stringify(row.differences)}</pre></td></tr>
              ))}</tbody>
            </table>
          </div>
          <h3>{t('p93AuditEvents')}</h3>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>{t('colTime')}</th><th>{t('colRecord')}</th><th>{t('colEvent')}</th><th>{t('colActor')}</th><th>{t('colReason')}</th></tr></thead>
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
