// Runs ad-hoc read-only DAX queries against the open fixture report and prints the results (for triage).
//   node tools/dax-record/probe.mjs "EVALUATE ROW(\"a\", 1)" "EVALUATE ..."
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const qs = process.argv.slice(2);
const tmp = mkdtempSync(join(tmpdir(), 'daxprobe-'));
writeFileSync(join(tmp, 'q.json'), JSON.stringify(qs.map((query, i) => ({ id: String(i), query }))));
const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'tools', 'dax-record', 'query.ps1'), '-Requests', join(tmp, 'q.json'), '-Out', join(tmp, 'o.json')], { stdio: ['ignore', 'ignore', 'inherit'] });
if (r.status !== 0) process.exit(1);
for (const x of JSON.parse(readFileSync(join(tmp, 'o.json'), 'utf8')).results) {
  console.log(`## ${qs[+x.id]}`);
  if (!x.ok) { console.log('ERROR:', String(x.error).replace(/^Exception calling[^:]*: "/, '').slice(0, 250)); continue; }
  console.log(JSON.stringify(x.columns), JSON.stringify(x.types));
  for (const row of x.rows.slice(0, 40)) console.log(JSON.stringify(row));
}
