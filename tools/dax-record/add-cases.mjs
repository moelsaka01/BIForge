// Adds pending cases (no expected result yet) to tests/dax/cases/<area>.json.
//
//   node tools/dax-record/add-cases.mjs <area> <list.txt>
//
// list.txt: one case per line, "id | query" (a query is one line; blank lines and lines starting with # are
// ignored). Existing ids are left alone. Then run record.mjs against an open fixture report to fill the answers.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dirIdx = process.argv.indexOf('--dir');
const dir = dirIdx >= 0 ? process.argv[dirIdx + 1] : 'cases';
const [area, list] = process.argv.slice(2).filter((a, i, all) => a !== '--dir' && all[i - 1] !== '--dir');
if (!area || !list) { console.error('usage: add-cases.mjs <area> <list.txt>'); process.exit(2); }
const path = join(root, 'tests', 'dax', dir, `${area}.json`);
const doc = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { area, fixture: 'tests/dax/fixtures', cases: [] };
const have = new Set(doc.cases.map((c) => c.id));
let added = 0;
for (const raw of readFileSync(list, 'utf8').split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const i = line.indexOf('|');
  const id = line.slice(0, i).trim();
  const query = line.slice(i + 1).trim();
  if (!id || !query || have.has(id)) continue;
  doc.cases.push({ id, query, source: 'pending', expected: null });
  have.add(id);
  added++;
}
writeFileSync(path, JSON.stringify(doc));
spawnSync('node', [join(root, 'tools', 'dax-record', 'record.mjs'), '--format', '--dir', dir], { stdio: 'inherit' });
console.log(`${added} case(s) added to ${area}.json (${doc.cases.length} total)`);
