// Summary and gate of the full render audit (render-all.mjs): the latest result of every case in e2e/_cases/results.jsonl.
// Exit code 1 when a property that must draw does not (FAIL, DOM-ONLY, NODATA) or a case has no result. Run: node e2e/render-report.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const dir = fileURLToPath(new URL("./_cases/", import.meta.url));
const all = JSON.parse(readFileSync(join(dir, "all.json"), "utf8"));
const latest = new Map();
for (const l of readFileSync(join(dir, "results.jsonl"), "utf8").split("\n")) if (l.trim()) { const r = JSON.parse(l); latest.set(r.idx, r); }
// properties that cannot be drawn yet, each with a class and a reason (src/core/format/auditNotDrawn.json): reported, not counted as a failure
const classified = new Map();
for (const g of JSON.parse(readFileSync(fileURLToPath(new URL("../src/core/format/auditNotDrawn.json", import.meta.url)), "utf8"))) for (const k of g.props) classified.set(k, g);
const tally = {};
const bad = [];
let missing = 0;
for (let i = 0; i < all.length; i++) {
  const r = latest.get(i);
  const key = `${all[i].visualType}.${all[i].object}.${all[i].prop}`;
  if (classified.has(key)) { const g = classified.get(key); tally[`classified: ${g.class}`] = (tally[`classified: ${g.class}`] ?? 0) + 1; continue; }
  if (!r) { missing++; continue; }
  tally[r.status] = (tally[r.status] ?? 0) + 1;
  if (/^(FAIL|DOM-ONLY|NODATA)$/.test(r.status)) bad.push(`${r.status} ${r.key}`);
}
console.log(`properties audited: ${all.length}`);
for (const [k, v] of Object.entries(tally).sort()) console.log(`  ${k}: ${v}`);
console.log(`  no result: ${missing}`);
const why = new Map();
for (const r of latest.values()) if (r.why) why.set(`${r.status} ${r.why}`, (why.get(`${r.status} ${r.why}`) ?? 0) + 1);
for (const [k, v] of why) console.log(`  ${k} (${v})`);
if (bad.length) console.log("not drawn:\n" + bad.join("\n"));
process.exit(bad.length || missing ? 1 : 0);
