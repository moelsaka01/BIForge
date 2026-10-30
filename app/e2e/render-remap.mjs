// Keeps the audit results across a regeneration of e2e/_cases/all.json (adding cases changes every later index): results are carried over by
// (key, occurrence), so a property that did not change is not run again. Usage, right BEFORE regenerating all.json:
//   node e2e/render-remap.mjs save              (writes e2e/_cases/by-key.json from results.jsonl)
// and right AFTER:
//   node e2e/render-remap.mjs load [dropPattern]  (rewrites results.jsonl for the new indices; results whose key matches dropPattern, and every
//                                                  FAIL / DOM-ONLY / NODATA, are left out, so render-all.mjs runs them again)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("./_cases/", import.meta.url));
const [mode, dropArg] = process.argv.slice(2);
const keyOf = (c) => `${c.visualType}.${c.object}.${c.prop}`;

if (mode === "save") {
  const all = JSON.parse(readFileSync(dir + "all.json", "utf8"));
  const latest = new Map();
  for (const l of readFileSync(dir + "results.jsonl", "utf8").split("\n")) if (l.trim()) { const r = JSON.parse(l); latest.set(r.idx, r); }
  const seen = new Map();
  const out = {};
  all.forEach((c, i) => {
    const k = keyOf(c);
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    const r = latest.get(i);
    if (r) out[`${k}#${n}`] = r;
  });
  writeFileSync(dir + "by-key.json", JSON.stringify(out));
  console.log(`saved ${Object.keys(out).length} results`);
} else if (mode === "load") {
  const all = JSON.parse(readFileSync(dir + "all.json", "utf8"));
  const saved = JSON.parse(readFileSync(dir + "by-key.json", "utf8"));
  const drop = dropArg ? new RegExp(dropArg) : null;
  const seen = new Map();
  const lines = [];
  let kept = 0;
  all.forEach((c, i) => {
    const k = keyOf(c);
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    const r = saved[`${k}#${n}`];
    if (!r || /^(FAIL|DOM-ONLY|NODATA)$/.test(r.status) || (drop && drop.test(k))) return;
    lines.push(JSON.stringify({ ...r, idx: i }));
    kept++;
  });
  writeFileSync(dir + "results.jsonl", lines.join("\n") + "\n");
  console.log(`kept ${kept} of ${all.length}; ${all.length - kept} will run again`);
} else throw new Error("usage: render-remap.mjs save | load [dropPattern]");
