/**
 * EVE AI Agent Universal CLI & Trading Decision Engine
 */
import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { DataCenter } from '../src/trading/data-center.js';
import { FeeEngine, ALPHA_DEFAULT_SKILLS } from '../src/trading/fee-engine.js';
import { StationArbitrageStrategy } from '../src/trading/strategies/station-arbitrage.js';
import { RegionalHaulingStrategy, STANDARD_HIGHSEC_ROUTES } from '../src/trading/strategies/regional-hauling.js';
import { ManufacturingArbitrageStrategy } from '../src/trading/strategies/manufacturing-arbitrage.js';
import { PortfolioManager, DEFAULT_RISK_LIMITS } from '../src/trading/portfolio-manager.js';
import { DraftSystem } from '../src/trading/draft-system.js';
import { BacktestingEngine } from '../src/trading/backtesting/engine.js';

const DB_PATH = process.env.DB_PATH || '/home/ubuntu/projects/eveai/data/eve-agent.db';
const BASE_URL = process.env.WEB_BASE_URL || 'http://localhost:3000';

function getDb(): Database.Database {
  return new Database(resolve(DB_PATH), { readonly: false });
}

function getLinkedCharId(db: Database.Database): number | null {
  const row = db.prepare("SELECT character_id FROM eve_character_links LIMIT 1").get() as any;
  return row?.character_id || null;
}

async function cmdStatus() {
  try {
    const res = await fetch(`${BASE_URL}/health`);
    const data = await res.json() as any;
    console.log(`[EVE AI Agent Daemon]: Online (${BASE_URL})`);
    console.log(`Status: ${data.status}, DB: ${data.checks?.database?.status}`);
  } catch (err) {
    console.log(`[EVE AI Agent Daemon]: Offline or unreachable (${BASE_URL})`);
  }

  try {
    const db = getDb();
    const types = db.prepare("SELECT count(*) as c FROM sde_types").get() as { c: number };
    const systems = db.prepare("SELECT count(*) as c FROM sde_systems").get() as { c: number };
    const chars = db.prepare("SELECT count(*) as c FROM eve_character_links").get() as { c: number };
    const orders = db.prepare("SELECT count(*) as c FROM market_orders").get() as { c: number };
    console.log(`[SDE Database]: ${types.c.toLocaleString()} items, ${systems.c.toLocaleString()} solar systems`);
    console.log(`[Market Orders]: ${orders.c.toLocaleString()} active orders cached`);
    console.log(`[Characters]: ${chars.c} linked character(s)`);
  } catch (err) {
    console.log(`[SDE Database]: Error accessing database: ${(err as Error).message}`);
  }
}

async function cmdCapital() {
  const db = getDb();
  const charId = getLinkedCharId(db);
  if (!charId) {
    console.log("尚未关联角色。请在浏览器 http://localhost:3000 完成 EVE SSO 登录。");
    return;
  }
  const acc = db.prepare("SELECT character_name FROM eve_accounts WHERE character_id = ?").get(charId) as any;
  const bd = PortfolioManager.getCapitalBreakdown(db, charId);

  console.log(`\n=== 飞行员财务与风险限额概况 (${acc?.character_name || charId}) ===`);
  console.log(`• 钱包可用现金: ${bd.walletBalance.toLocaleString()} ISK`);
  console.log(`• 市场买单锁定 (Escrow): ${bd.escrowLocked.toLocaleString()} ISK`);
  console.log(`• 个人库存估值: ${bd.inventoryEstimatedValue.toLocaleString()} ISK`);
  console.log(`• 总净资产估值: ${bd.totalNetWorth.toLocaleString()} ISK`);
  console.log(`----------------------------------------------------`);
  console.log(`• 强制 20% 现金储备底线: ${bd.cashReserveRequired.toLocaleString()} ISK (禁止挪用)`);
  console.log(`• 当前实际可投资金 (Investable): ${bd.investableCapital.toLocaleString()} ISK`);
  console.log(`• 单一物品投资上限 (15%): ${bd.singleItemCapIsk.toLocaleString()} ISK`);
  console.log(`• 单一品类投资上限 (30%): ${bd.categoryCapIsk.toLocaleString()} ISK`);
  console.log(`• T1 工业舰单趟货运防强杀上限: ${DEFAULT_RISK_LIMITS.maxHaulingCargoIsk.toLocaleString()} ISK\n`);
}

async function cmdScanStation(stationArg?: string) {
  const db = getDb();
  const stationId = stationArg && /^\d+$/.test(stationArg) ? Number(stationArg) : 60003760; // Jita 4-4
  const opps = StationArbitrageStrategy.scan(db, {
    stationId,
    regionId: 10000002,
    minNetMarginPct: 8.0,
    minNetProfit: 50_000,
    maxCapitalPerItem: 30_000_000,
  });

  console.log(`\n=== 站内套利扫描 (Station Arbitrage) ===`);
  console.log(`扫描目标: 空间站 ${stationId} | 发现机会: ${opps.length} 项\n`);
  if (opps.length === 0) {
    console.log("未发现符合风控与利润要求的站内套利机会。");
    return;
  }

  for (const o of opps.slice(0, 10)) {
    console.log(`• [${o.typeId}] ${o.zhName || o.typeName} (${o.groupName || '其他'}) - 流动性[${o.liquidityRating}] 风险[${o.riskScore}]`);
    console.log(`  买单收: ${Math.round(o.suggestedBuyPrice).toLocaleString()} | 卖单出: ${Math.round(o.suggestedSellPrice).toLocaleString()} ISK`);
    console.log(`  建议规模: ${o.suggestedQuantity} 件 | 所需本金: ${Math.round(o.capitalRequired).toLocaleString()} ISK`);
    console.log(`  扣税净利: +${Math.round(o.expectedNetProfit).toLocaleString()} ISK (ROI: +${o.expectedRoiPct.toFixed(1)}%) | 预估周转: ${o.turnoverDays} 天\n`);
  }
}

async function cmdScanHaul(routeIndexArg?: string) {
  const db = getDb();
  const idx = routeIndexArg && /^\d+$/.test(routeIndexArg) ? Number(routeIndexArg) : 0;
  const route = STANDARD_HIGHSEC_ROUTES[idx] || STANDARD_HIGHSEC_ROUTES[0];

  const opps = RegionalHaulingStrategy.scan(db, {
    route,
    mode: 'all',
    minNetMarginPct: 6.0,
    minNetProfit: 100_000,
    maxCapital: 50_000_000,
    maxCargoM3: 5_000,
  });

  console.log(`\n=== 跨贸易中心高安航运扫描 (${route.originName} ➔ ${route.destName}, ${route.highSecJumps}跳) ===`);
  console.log(`发现套利机会: ${opps.length} 项 (已施加 5000万货值防强杀与 5000m³ 货舱过滤)\n`);

  if (opps.length === 0) {
    console.log("当前航线未发现满足利润与深度要求的机会。");
    return;
  }

  for (const o of opps.slice(0, 8)) {
    console.log(`• [${o.typeId}] ${o.zhName || o.typeName} (${o.groupName || '其他'})`);
    console.log(`  ${o.rationale}\n`);
  }
}

async function cmdDrafts() {
  const db = getDb();
  const charId = getLinkedCharId(db);
  if (!charId) {
    console.log("尚未关联角色。");
    return;
  }
  const drafts = DraftSystem.getDrafts(db, charId);
  console.log(`\n=== 交易订单草案清单 (${drafts.length} 份) ===`);
  if (drafts.length === 0) {
    console.log("暂无生成的交易草案。可执行 `eve-agent draft-auto` 自动从最优套利机会生成。");
    return;
  }
  for (const d of drafts) {
    console.log(`[${d.draftId}] 状态: ${d.status.toUpperCase()} | 策略: ${d.strategy}`);
    console.log(`  物品 ID ${d.typeId} x ${d.suggestedQty} | 建议买入: ${d.suggestedBuy.toLocaleString()} | 建议卖出: ${d.suggestedSell.toLocaleString()}`);
    console.log(`  本金需求: ${Math.round(d.capitalRequired).toLocaleString()} ISK | 预计净利: +${Math.round(d.expectedProfit).toLocaleString()} ISK (ROI: +${d.expectedRoi.toFixed(1)}%)`);
    if (d.status === 'executed_manually') {
      console.log(`  实际成交: 买 ${d.actualBuyPrice} / 卖 ${d.actualSellPrice} | 实际盈亏: ${d.actualProfit?.toLocaleString()} ISK`);
    }
    console.log();
  }
}

async function cmdDraftAuto() {
  const db = getDb();
  const charId = getLinkedCharId(db);
  if (!charId) {
    console.log("尚未关联角色。");
    return;
  }

  const bd = PortfolioManager.getCapitalBreakdown(db, charId);
  console.log(`当前可支配投资额度: ${Math.round(bd.investableCapital).toLocaleString()} ISK (单品上限: ${Math.round(bd.singleItemCapIsk).toLocaleString()} ISK)`);

  const haulOpps = RegionalHaulingStrategy.scan(db, {
    route: STANDARD_HIGHSEC_ROUTES[0],
    mode: 'instant_fill',
    minNetMarginPct: 8.0,
    minNetProfit: 200_000,
    maxCapital: bd.singleItemCapIsk,
  });

  const validOpps = haulOpps.filter(o => {
    const riskCheck = PortfolioManager.validateTradeRisk(bd, o.capitalRequired, o.strategy, o.volumeM3 * o.suggestedQuantity);
    return riskCheck.allowed;
  });

  if (validOpps.length === 0) {
    console.log("当前无满足全部风控条件的即时套利机会。");
    return;
  }

  const chosen = validOpps[0];
  const draft = DraftSystem.createDraft(db, charId, chosen, 24);
  console.log(`\n成功生成交易订单草案: 【${draft.draftId}】`);
  console.log(`• 标的物品: [${chosen.typeId}] ${chosen.zhName || chosen.typeName}`);
  console.log(`• 采购地点: ${chosen.buyStationName} (买入价: ${chosen.suggestedBuyPrice.toLocaleString()} ISK)`);
  console.log(`• 销售地点: ${chosen.sellStationName} (即时变现买单价: ${chosen.suggestedSellPrice.toLocaleString()} ISK)`);
  console.log(`• 建议数量: ${chosen.suggestedQuantity} 件 | 货舱体积: ${(chosen.volumeM3 * chosen.suggestedQuantity).toFixed(1)} m³`);
  console.log(`• 资金占用: ${Math.round(draft.capitalRequired).toLocaleString()} ISK`);
  console.log(`• 预计净利润: +${Math.round(draft.expectedProfit).toLocaleString()} ISK (净ROI: +${draft.expectedRoi.toFixed(1)}%)`);
  console.log(`• 有效期至: ${draft.expiresAt}`);
  console.log(`\n提示: 请在浏览器管理面板或通过 \`eve-agent draft-approve ${draft.draftId}\` 确认草案，并在游戏客户端中手动执行下单！`);
}

async function cmdDraftApprove(draftId: string) {
  if (!draftId) {
    console.error("Usage: eve-agent draft-approve <draftId>");
    return;
  }
  const db = getDb();
  const ok = DraftSystem.updateStatus(db, draftId, 'approved');
  if (ok) {
    console.log(`草案 ${draftId} 状态已更新为: APPROVED (已审批认可，等待飞行员在游戏中手动执行)`);
  } else {
    console.log(`未找到草案 ${draftId}`);
  }
}

async function cmdItem(query: string) {
  if (!query) {
    console.error("Usage: eve-agent item <name_or_id>");
    process.exit(1);
  }
  const db = getDb();
  let rows: any[] = [];
  if (/^\d+$/.test(query)) {
    rows = db.prepare(`
      SELECT t.type_id, t.name, t.zh_name, g.zh_name as group_name, c.zh_name as cat_name,
             json_extract(t.data_json, '$.mass') as mass,
             json_extract(t.data_json, '$.volume') as volume,
             json_extract(t.data_json, '$.basePrice') as base_price
      FROM sde_types t
      LEFT JOIN sde_groups g ON t.group_id = g.group_id
      LEFT JOIN sde_categories c ON g.category_id = c.category_id
      WHERE t.type_id = ?
    `).all(Number(query));
  } else {
    rows = db.prepare(`
      SELECT t.type_id, t.name, t.zh_name, g.zh_name as group_name, c.zh_name as cat_name,
             json_extract(t.data_json, '$.mass') as mass,
             json_extract(t.data_json, '$.volume') as volume,
             json_extract(t.data_json, '$.basePrice') as base_price
      FROM sde_types t
      LEFT JOIN sde_groups g ON t.group_id = g.group_id
      LEFT JOIN sde_categories c ON g.category_id = c.category_id
      WHERE t.zh_name LIKE ? OR t.name LIKE ?
      LIMIT 10
    `).all(`%${query}%`, `%${query}%`);
  }

  if (rows.length === 0) {
    console.log(`未找到与 "${query}" 匹配的物品。`);
    return;
  }

  console.log(`\n找到 ${rows.length} 个匹配物品：\n`);
  for (const r of rows) {
    console.log(`- [${r.type_id}] ${r.zh_name || r.name} (${r.name})`);
    console.log(`  分类: ${r.cat_name || 'N/A'} > ${r.group_name || 'N/A'} | 体积: ${r.volume || 0} m³ | 质量: ${r.mass || 0} kg | 基础参考价: ${(r.base_price || 0).toLocaleString()} ISK`);
  }
}

async function cmdReprocess(query: string) {
  if (!query) {
    console.error("Usage: eve-agent reprocess <item_name_or_id>");
    process.exit(1);
  }
  const db = getDb();
  let item = db.prepare("SELECT type_id FROM sde_types WHERE type_id = ? OR zh_name = ? OR name = ? LIMIT 1").get(query, query, query) as any;
  if (!item) {
    item = db.prepare("SELECT type_id FROM sde_types WHERE zh_name LIKE ? OR name LIKE ? LIMIT 1").get(`%${query}%`, `%${query}%`) as any;
  }
  if (!item) {
    console.log(`未找到物品 "${query}"`);
    return;
  }

  const analysis = ManufacturingArbitrageStrategy.analyzeReprocessing(db, item.type_id);
  if (!analysis) {
    console.log(`物品 [${item.type_id}] 无法再处理或缺少矿物数据。`);
    return;
  }

  console.log(`\n=== 物品再处理分析: ${analysis.name} (${analysis.enName}) ===`);
  console.log(`基准解体批次单位: ${analysis.portionSize} 件 | 设定精炼效率: ${(analysis.reprocessYieldPct * 100).toFixed(0)}%`);
  console.log(`吉他直接卖单单价: ${analysis.stationBuyPrice.toLocaleString()} ISK`);
  console.log(`产出矿物变现总估值: ${analysis.totalMineralValue.toLocaleString()} ISK`);
  console.log(`产出材料明细:`);
  for (const m of analysis.minerals) {
    console.log(`  • ${m.name}: ${m.quantity.toLocaleString()} 基础单位 (买单单价 ${m.unitBuyPrice} ISK -> ${m.totalIsk.toLocaleString()} ISK)`);
  }
  console.log(`\n决策建议: 【${analysis.recommendation.toUpperCase()}】`);
  console.log(`分析理由: ${analysis.rationale}`);
}

async function cmdAsk(prompt: string) {
  if (!prompt) {
    console.error("Usage: eve-agent ask <prompt>");
    process.exit(1);
  }

  try {
    const sResp = await fetch(`${BASE_URL}/api/web/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': BASE_URL },
      body: '{}'
    });
    const sData = (await sResp.json()) as any;
    let cookie = '';
    if (typeof sResp.headers.getSetCookie === 'function') {
      cookie = sResp.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    } else {
      cookie = sResp.headers.get('set-cookie')?.split(';')[0] || '';
    }
    const csrfToken = sData.session?.csrfToken;

    if (!csrfToken) {
      throw new Error(`Could not obtain CSRF token from daemon: ${JSON.stringify(sData)}`);
    }

    const cResp = await fetch(`${BASE_URL}/api/web/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': BASE_URL,
        'Cookie': cookie,
        'x-csrf-token': csrfToken
      },
      body: JSON.stringify({ message: prompt })
    });
    const cData = await cResp.json() as any;
    if (!cData.pollUrl) {
      console.error("Agent request failed:", cData.error || cData);
      return;
    }

    process.stdout.write("Agent 思考中...");
    const pollUrl = `${BASE_URL}${cData.pollUrl}`;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 2000));
      process.stdout.write(".");
      const pResp = await fetch(pollUrl, {
        headers: { 'Origin': BASE_URL, 'Cookie': cookie }
      });
      const pData = await pResp.json() as any;
      const status = pData.request?.status;
      if (status === 'completed') {
        process.stdout.write("\n\n");
        const db = getDb();
        const msg = db.prepare("SELECT content FROM messages WHERE role='assistant' ORDER BY id DESC LIMIT 1").get() as any;
        console.log(msg?.content || "回答已完成，未读取到消息体。");
        return;
      } else if (status === 'failed') {
        process.stdout.write("\n\n");
        console.error("Agent 执行失败:", pData.request?.error);
        return;
      }
    }
    console.error("\n请求超时。");
  } catch (err) {
    console.error(`与 EVE AI Agent 服务通信异常 (${BASE_URL}):`, (err as Error).message);
    console.log("提示：请确认服务正在运行 (`sudo systemctl status eveai.service`)");
  }
}

async function cmdSdeSql(sql: string) {
  if (!sql) {
    console.error("Usage: eve-agent sde <SQL_QUERY>");
    process.exit(1);
  }
  const cleanSql = sql.replace(/^['"]|['"]$/g, '').trim();
  if (!cleanSql.toLowerCase().startsWith('select') && !cleanSql.toLowerCase().startsWith('pragma') && !cleanSql.toLowerCase().startsWith('explain')) {
    console.error("仅允许执行只读 SELECT 查询！");
    process.exit(1);
  }
  try {
    const db = getDb();
    const rows = db.prepare(cleanSql).all();
    console.log(JSON.stringify(rows, null, 2));
  } catch (err) {
    console.error("SQL 查询错误:", (err as Error).message);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'status';

  switch (command) {
    case 'status':
      await cmdStatus();
      break;
    case 'capital':
      await cmdCapital();
      break;
    case 'scan-station':
      await cmdScanStation(args[1]);
      break;
    case 'scan-haul':
      await cmdScanHaul(args[1]);
      break;
    case 'drafts':
      await cmdDrafts();
      break;
    case 'draft-auto':
      await cmdDraftAuto();
      break;
    case 'draft-approve':
      await cmdDraftApprove(args[1]);
      break;
    case 'item':
      await cmdItem(args.slice(1).join(' '));
      break;
    case 'reprocess':
      await cmdReprocess(args.slice(1).join(' '));
      break;
    case 'ask':
      await cmdAsk(args.slice(1).join(' '));
      break;
    case 'sde':
      await cmdSdeSql(args.slice(1).join(' '));
      break;
    default:
      console.log(`EVE AI Agent 市场投资与交易决策 CLI 工具箱

基础查询:
  eve-agent status                  查看服务运行状态与全域订单库统计
  eve-agent item "<物品名或ID>"     极速查询物品属性、体积、质量与中英文名
  eve-agent reprocess "<物品名>"    计算再处理矿物产出比价分析
  eve-agent sde "<SELECT语句>"      直接执行本地 SDE 只读 SQL 查询
  eve-agent ask "<投资咨询问题>"    向 AI 战术副官发起多轮投资对话

投资与决策引擎 (P1-P4):
  eve-agent capital                 查看角色动态资金、20%强制储备金与单品限额
  eve-agent scan-station [station]  执行站内套利扫描 (默认 Jita 4-4)
  eve-agent scan-haul [0|1|2]       执行高安跨区航运套利扫描 (0=Dodixie, 1=Hek, 2=Rens)
  eve-agent drafts                  查看已生成的交易订单草案清单
  eve-agent draft-auto              根据当前资金与风控自动生成最优订单草案 (TR-XXXXXX)
  eve-agent draft-approve <TR-ID>   飞行员审批确认草案（审批后在游戏客户端中手动执行）
`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

