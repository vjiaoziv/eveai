import type { Db } from '../db/sqlite.js';
import { runModelText } from '../agent/model.js';
import type { NativeUsage } from '../agent/native-responses.js';
import type { UserContext } from '../auth/user-resolver.js';

export type P9AnalysisMode = 'opportunity' | 'daily';

export interface P9AnalysisInput {
  mode: P9AnalysisMode;
  opportunityIds?: string[];
}

export interface P9AnalysisOutcome {
  ok: boolean;
  text: string;
  opportunityIds: string[];
  snapshotIds: string[];
  dataTimes: string[];
  usage?: Parameters<NonNullable<Parameters<typeof runModelText>[3]>>[0];
  error?: string;
}

const DEVELOPER_PROMPT = `你是 EVEAI 的交易研究助手，不是财务计算引擎。
只解释用户提供的确定性数据，不得重新计算或改写价格、数量、费用、利润、风险阈值。
每个结论必须引用 opportunityId、buySnapshotId/sellSnapshotId 和数据时间。
数据不足、物流成本未知或综合净利润为 UNKNOWN 时，必须明确说无法判断。
禁止建议绕过风控，禁止声称自动真实交易，禁止把 Paper Trading 收益说成真实盈利。
输出简洁中文，结构化分为：机会解释、利润来源、主要风险、建议/不建议原因、数据限制。`;

function safeJson(value: unknown, maxLength = 12_000): string {
  const raw = JSON.stringify(value, null, 2);
  return raw.length > maxLength ? raw.slice(0, maxLength) + '\n...[truncated]' : raw;
}

export function buildP9AnalysisPrompt(db: Db, characterId: number, input: P9AnalysisInput): {
  prompt: string;
  opportunityIds: string[];
  snapshotIds: string[];
  dataTimes: string[];
} {
  const ids = (input.opportunityIds || []).filter((id) => typeof id === 'string' && id.length > 0).slice(0, 8);
  const where = ids.length > 0
    ? `AND opportunity_id IN (${ids.map(() => '?').join(', ')})`
    : '';
  const rows = ids.length > 0
    ? db.prepare(`
        SELECT * FROM p9_real_opportunities
        WHERE character_id = ? ${where}
        ORDER BY fee_net_profit DESC
      `).all(characterId, ...ids) as any[]
    : db.prepare(`
        SELECT * FROM p9_real_opportunities
        WHERE character_id = ? AND state IN ('ACTIONABLE', 'WATCHING', 'STALE', 'EXPIRED')
        ORDER BY updated_at DESC LIMIT 8
      `).all(characterId) as any[];

  const trades = db.prepare(`
    SELECT trade_id, direction, type_id, location_id, quantity, price, fee, fee_status,
           realized_pnl, pnl_status, trade_time, source, opportunity_id, plan_id
    FROM p9_real_trades WHERE character_id = ?
    ORDER BY trade_time DESC LIMIT 20
  `).all(characterId) as any[];
  const portfolio = db.prepare(`
    SELECT
      (SELECT balance FROM character_wallet WHERE character_id = ?) AS wallet_balance,
      (SELECT COUNT(*) FROM p9_inventory_lots WHERE character_id = ? AND quantity > 0) AS active_lots,
      (SELECT COUNT(*) FROM p9_inventory_lots WHERE character_id = ? AND cost_status = 'UNKNOWN' AND quantity > 0) AS unknown_cost_lots,
      (SELECT COUNT(*) FROM p9_real_opportunities WHERE character_id = ? AND state = 'ACTIONABLE') AS actionable_count
  `).get(characterId, characterId, characterId, characterId) as any;

  const payload = {
    mode: input.mode,
    deterministicData: {
      opportunities: rows.map((row) => ({
        opportunityId: row.opportunity_id,
        state: row.state,
        strategy: row.strategy,
        typeId: row.type_id,
        names: { en: row.type_name_en, zh: row.type_name_zh },
        route: {
          buy: { locationId: row.buy_location_id, name: row.buy_location_name, regionId: row.buy_region_id },
          sell: { locationId: row.sell_location_id, name: row.sell_location_name, regionId: row.sell_region_id },
        },
        prices: { buy: row.buy_price, sell: row.sell_price },
        quantities: { suggested: row.suggested_quantity, executable: row.executable_quantity },
        profitLayers: {
          theoreticalGross: row.theoretical_gross_profit,
          executableGross: row.executable_gross_profit,
          feeNet: row.fee_net_profit,
          comprehensive: row.comprehensive_net_profit,
          comprehensiveStatus: row.comprehensive_status,
          logisticsCost: row.logistics_cost,
        },
        capitalRequired: row.capital_required,
        roiPct: row.roi_pct,
        risk: { level: row.risk_level, flags: row.risk_flags_json },
        snapshots: {
          buyId: row.buy_snapshot_id,
          sellId: row.sell_snapshot_id,
          buyAt: row.buy_snapshot_at,
          sellAt: row.sell_snapshot_at,
          buyAgeMinutes: row.buy_snapshot_age_minutes,
          sellAgeMinutes: row.sell_snapshot_age_minutes,
          dataComplete: Boolean(row.data_complete),
          dataFresh: Boolean(row.data_fresh),
        },
        calculationVersion: row.calculation_version,
        detectedAt: row.detected_at,
        updatedAt: row.updated_at,
        expiresAt: row.expires_at,
      })),
      recentTrades: trades,
      portfolio,
    },
    hardLimits: [
      '不得自行加减乘除生成新的利润数字',
      '综合净利润 UNKNOWN 时不得推测为 0',
      '物流成本未知时不得把费用后净利润称为最终可实现利润',
      '不得输出真实自动交易或 REAL_TRADING_READY',
    ],
  };

  const opportunityIds = rows.map((row) => String(row.opportunity_id));
  const snapshotIds = rows.flatMap((row) => [String(row.buy_snapshot_id), String(row.sell_snapshot_id)]);
  const dataTimes = rows.map((row) => String(row.updated_at));
  return {
    prompt: `${input.mode === 'daily' ? '生成每日交易研究报告。' : '分析指定机会。'}\n\n以下是确定性数据，不得改写：\n${safeJson(payload)}`,
    opportunityIds,
    snapshotIds,
    dataTimes,
  };
}

export async function runP9Analysis(
  db: Db,
  characterId: number,
  input: P9AnalysisInput,
  ctx?: UserContext,
  signal?: AbortSignal,
): Promise<P9AnalysisOutcome> {
  const built = buildP9AnalysisPrompt(db, characterId, input);
  let capturedUsage: NativeUsage | undefined;
  try {
    const text = await runModelText(
      DEVELOPER_PROMPT,
      built.prompt,
      signal,
      (usage) => { capturedUsage = usage; },
    );
    return {
      ok: true,
      text,
      opportunityIds: built.opportunityIds,
      snapshotIds: built.snapshotIds,
      dataTimes: built.dataTimes,
      usage: capturedUsage,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      text: '',
      opportunityIds: built.opportunityIds,
      snapshotIds: built.snapshotIds,
      dataTimes: built.dataTimes,
      usage: capturedUsage,
      error: message,
    };
  }
}