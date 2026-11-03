import { mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { P93AuditService } from '../src/trading/p9-3-audit-service.js';

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

async function main(): Promise<void> {
  const sourcePath = resolve(arg('db') ?? 'data/eveai.db');
  const outputDir = resolve(arg('out') ?? 'data/backups');
  const source = new Database(sourcePath, { readonly: true });
  const before = P93AuditService.integrityCheck(source as never);
  if (!before.ok) throw new Error('源数据库完整性检查失败：' + before.findings.join('; '));
  mkdirSync(outputDir, { recursive: true });
  const destination = join(outputDir, `eveai-p93-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  await source.backup(destination);
  source.close();

  const restored = new Database(destination, { readonly: true });
  const after = P93AuditService.integrityCheck(restored as never);
  const recordCount = Number((restored.prepare('SELECT COUNT(*) AS n FROM real_trade_records').get() as any)?.n || 0);
  const eventCount = Number((restored.prepare('SELECT COUNT(*) AS n FROM real_trade_events').get() as any)?.n || 0);
  restored.close();
  if (!after.ok) throw new Error('恢复验证失败：' + after.findings.join('; '));
  const size = statSync(destination).size;
  process.stdout.write(JSON.stringify({ ok: true, destination, size, recordCount, eventCount, integrity: after }, null, 2));
}

main().catch((error) => {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});