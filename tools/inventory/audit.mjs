// Audit of the hand-written Done-tested items (D in manual-*.txt): each needs evidence in tools/inventory/tests-map.txt, a line
// "area|item text => test file :: regex ;; test file :: regex". Every piece of evidence must name an existing file whose text matches
// the regex. The generated areas are checked separately (format cards by coverage.test.ts, DAX functions and M functions below).
//   node tools/inventory/audit.mjs            list the items without valid evidence
//   node tools/inventory/audit.mjs --check    exit 1 when there are any (run before flipping an item to D)
import fs from "node:fs";
import path from "node:path";
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const root = path.resolve(here, "..", "..");
const map = new Map();
for (const l of fs.readFileSync(path.join(here, "tests-map.txt"), "utf8").split(/\r?\n/)) {
  if (!l.trim() || l.startsWith("#")) continue;
  const i = l.indexOf(" => ");
  if (i < 0) throw new Error("bad map line: " + l);
  map.set(l.slice(0, i), l.slice(i + 4).split(" ;; ").map((e) => { const j = e.indexOf(" :: "); return { file: e.slice(0, j), re: e.slice(j + 4) }; }));
}
const cache = new Map();
const text = (f) => { if (!cache.has(f)) { const p = path.join(root, f); cache.set(f, fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null); } return cache.get(f); };
const items = [];
for (const f of fs.readdirSync(here).filter((x) => /^manual-\d+\.txt$/.test(x))) {
  let area = null;
  for (const l of fs.readFileSync(path.join(here, f), "utf8").split(/\r?\n/)) {
    const h = /^## (\d+)\./.exec(l); if (h) { area = h[1]; continue; }
    const m = /^D \| (.*)$/.exec(l); if (m) items.push(`${area}|${m[1]}`);
  }
}
const seen = new Set(); const bad = [];
for (const key of items) {
  seen.add(key);
  const ev = map.get(key);
  if (!ev) { bad.push(`${key}\n    no evidence`); continue; }
  const miss = ev.filter((e) => { const t = text(e.file); return t === null || !new RegExp(e.re.replace(/^\(\?i\)/, ""), e.re.startsWith("(?i)") ? "i" : "").test(t); });
  if (miss.length) bad.push(`${key}\n    ${miss.map((e) => (text(e.file) === null ? `missing file ${e.file}` : `${e.file} has no match for /${e.re}/`)).join("\n    ")}`);
}
for (const k of map.keys()) if (!seen.has(k)) console.log(`map entry for an item that is not Done-tested (or renamed): ${k}`);
console.log(bad.join("\n"));
console.log(`${items.length - bad.length} of ${items.length} Done-tested hand-written items have evidence; ${bad.length} do not`);
if (process.argv.includes("--check") && bad.length) process.exit(1);
