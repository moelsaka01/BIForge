// Prints a case's query and recorded result (for triage): node tools/dax-record/show.mjs <id>...
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'dax', 'cases');
const ids = process.argv.slice(2);
for (const f of readdirSync(dir)) {
  for (const c of JSON.parse(readFileSync(join(dir, f), 'utf8')).cases) {
    if (!ids.includes(c.id)) continue;
    console.log(`## ${c.id}\n${c.query}`);
    const e = c.expected;
    if (e?.error !== undefined) console.log('ERROR:', String(e.error).slice(0, 300));
    else if (e) { console.log(JSON.stringify(e.columns), JSON.stringify(e.types)); for (const r of e.rows.slice(0, 14)) console.log(JSON.stringify(r)); if (e.rows.length > 14) console.log('...', e.rows.length, 'rows'); }
  }
}
