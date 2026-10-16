// Records expected results for DAX conformance cases from the local engine of an open Power BI Desktop report.
//
//   node tools/dax-record/record.mjs [--only <regex>] [--redo] [--port N] [--dry]
//   node tools/dax-record/record.mjs --format      (rewrite the case files in the canonical layout)
//
// Cases live in tests/dax/cases/*.json. A case without "expected" is pending; this script asks the local engine
// (tools/dax-record/query.ps1: read-only EVALUATE queries) and writes the answer into the file. Recorded cases
// are marked "source": "recorded". --redo re-records cases that are already recorded (use after the fixture model
// changes); hand-written cases ("source": "hand") are never overwritten. Review the diff before committing.
import { readFileSync, writeFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
// --dir holdout records tests/dax/holdout instead of tests/dax/cases
const casesDir = join(root, 'tests', 'dax', opt('--dir') ?? 'cases');

// One case per few lines: keeps diffs reviewable.
export function serialize(doc) {
  const { cases, ...head } = doc;
  const lines = [];
  for (const c of cases) {
    const { expected, ...rest } = c;
    let s = '    {' + Object.entries(rest).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ');
    if (expected === undefined || expected === null) s += ', "expected": null}';
    else if (expected.error !== undefined) s += `, "expected": {"error": ${JSON.stringify(expected.error)}}}`;
    else {
      s += ',\n      "expected": {"columns": ' + JSON.stringify(expected.columns) + ', "types": ' + JSON.stringify(expected.types) + ',\n        "rows": [\n' +
        expected.rows.map((r) => '          ' + JSON.stringify(r)).join(',\n') + (expected.rows.length ? '\n' : '') + '        ]}}';
    }
    lines.push(s);
  }
  const meta = Object.entries(head).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  return '{\n' + meta.join(',\n') + (meta.length ? ',\n' : '') + '  "cases": [\n' + lines.join(',\n') + '\n  ]\n}\n';
}

const files = readdirSync(casesDir).filter((f) => f.endsWith('.json')).sort();
const docs = files.map((f) => ({ f, path: join(casesDir, f), doc: JSON.parse(readFileSync(join(casesDir, f), 'utf8')) }));

if (args.includes('--format')) {
  for (const d of docs) writeFileSync(d.path, serialize(d.doc));
  process.exit(0);
}

const only = opt('--only') ? new RegExp(opt('--only')) : null;
const redo = args.includes('--redo');
const todo = [];
for (const d of docs) for (const c of d.doc.cases) {
  if (only && !only.test(c.id)) continue;
  if (c.source === 'hand') continue;
  if (c.expected == null || redo) todo.push(c);
}
console.log(`${todo.length} case(s) to record`);
if (args.includes('--dry') || todo.length === 0) process.exit(0);

const tmp = mkdtempSync(join(tmpdir(), 'daxrec-'));
const req = join(tmp, 'requests.json');
const out = join(tmp, 'results.json');
writeFileSync(req, JSON.stringify(todo.map((c) => ({ id: c.id, query: c.query }))));
const ps = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'tools', 'dax-record', 'query.ps1'), '-Requests', req, '-Out', out];
if (opt('--port')) ps.push('-Port', opt('--port'));
const r = spawnSync('powershell.exe', ps, { stdio: 'inherit' });
if (r.status !== 0) { console.error('query.ps1 failed'); process.exit(1); }

const res = JSON.parse(readFileSync(out, 'utf8'));
const byId = new Map(res.results.map((x) => [x.id, x]));
let ok = 0, errs = 0;
for (const d of docs) {
  let changed = false;
  for (const c of d.doc.cases) {
    const x = byId.get(c.id);
    if (!x) continue;
    c.source = 'recorded';
    c.expected = x.ok ? { columns: x.columns, types: x.types, rows: x.rows } : { error: x.error };
    x.ok ? ok++ : errs++;
    changed = true;
  }
  if (changed) { d.doc.recordedWith = res.engine; writeFileSync(d.path, serialize(d.doc)); }
}
console.log(`recorded ${ok} result(s), ${errs} error result(s) (${res.engine})`);
