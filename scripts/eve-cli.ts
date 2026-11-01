import Database from 'better-sqlite3';
import { resolve } from 'node:path';

const DB_PATH = process.env.DB_PATH || '/home/ubuntu/projects/eveai/data/eve-agent.db';
const BASE_URL = process.env.WEB_BASE_URL || 'http://localhost:3000';

function getDb(): Database.Database {
  return new Database(resolve(DB_PATH), { readonly: true });
}

async function cmdStatus() {
  try {
    const res = await fetch(`${BASE_URL}/health`);
    const data = await res.json();
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
    console.log(`[SDE Database]: ${types.c.toLocaleString()} items, ${systems.c.toLocaleString()} solar systems`);
    console.log(`[Characters]: ${chars.c} linked character(s)`);
  } catch (err) {
    console.log(`[SDE Database]: Error accessing database: ${(err as Error).message}`);
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
  let item = db.prepare("SELECT type_id, name, zh_name, data_json FROM sde_types WHERE type_id = ? OR zh_name = ? OR name = ? LIMIT 1")
    .get(query, query, query) as any;
  if (!item) {
    item = db.prepare("SELECT type_id, name, zh_name, data_json FROM sde_types WHERE zh_name LIKE ? OR name LIKE ? LIMIT 1")
      .get(`%${query}%`, `%${query}%`) as any;
  }
  if (!item) {
    console.log(`未找到物品 "${query}"`);
    return;
  }

  const matRow = db.prepare("SELECT data_json FROM sde_type_materials WHERE type_id = ?").get(item.type_id) as any;
  if (!matRow) {
    console.log(`物品 [${item.type_id}] ${item.zh_name || item.name} 无法再处理或未包含矿物产出数据。`);
    return;
  }

  const matData = JSON.parse(matRow.data_json);
  const materials = matData.materials || [];
  const portionSize = JSON.parse(item.data_json)?.portionSize || 1;

  console.log(`\n=== 物品再处理分析: ${item.zh_name || item.name} (${item.name}) ===`);
  console.log(`基础解体批次单位 (portionSize): ${portionSize} 件`);
  console.log(`100% 理论基准产出材料：`);

  for (const m of materials) {
    const mItem = db.prepare("SELECT zh_name, name FROM sde_types WHERE type_id = ?").get(m.materialTypeID) as any;
    console.log(`  • ${mItem?.zh_name || mItem?.name || m.materialTypeID}: ${m.quantity.toLocaleString()} 基础单位`);
  }
  console.log(`\n注：实际产出需乘以当前空间站精炼效率 (如NPC站 50%) 及飞行员技能加成 (再处理技术/高级再处理技术)。`);
}

async function cmdAsk(prompt: string) {
  if (!prompt) {
    console.error("Usage: eve-agent ask <prompt>");
    process.exit(1);
  }

  // Check daemon
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
    const cData = await cResp.json();
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
      const pData = await pResp.json();
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
  const cleanSql = sql.trim();
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
      console.log(`EVE AI Agent CLI 工具箱

用法:
  eve-agent status                  查看服务运行状态与数据库记录数
  eve-agent ask "<问题>"            向 AI Agent 发起对话咨询（航线/配装/市场/局势）
  eve-agent item "<物品名或ID>"     快速查询物品属性（中英文名、体积、分类、基准价）
  eve-agent reprocess "<物品名>"    查询物品再处理（解体）矿物产出明细
  eve-agent sde "<SELECT语句>"      直接执行本地 SDE 只读 SQL 查询
`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});