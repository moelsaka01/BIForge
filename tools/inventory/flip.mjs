// Sets the status of hand-written inventory items (manual-*.txt) by area number and exact text:
//   node tools/inventory/flip.mjs D "7|Gridlines" "11|Align (left, center, right, top, middle, bottom)"
// The number before | is the area ("## 7. ..." heading); without it the first item with that text is changed.
// A status D means Done-tested: only flip an item when an automated test for it passes.
import fs from "node:fs";
import path from "node:path";
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const [status, ...specs] = process.argv.slice(2);
if (!["D", "P", "N"].includes(status) || specs.length === 0) throw new Error('usage: flip.mjs <D|P|N> "area|item text" ...');
const want = specs.map((s) => { const m = /^(\d+)\|(.*)$/s.exec(s); return m ? { area: m[1], text: m[2], spec: s } : { area: null, text: s, spec: s }; });
const done = new Set();
for (const f of fs.readdirSync(here).filter((x) => /^manual-\d+\.txt$/.test(x))) {
  const p = path.join(here, f);
  const raw = fs.readFileSync(p, "utf8");
  const crlf = raw.includes("\r\n");
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  let area = null, changed = false;
  for (let i = 0; i < lines.length; i++) {
    const h = /^## (\d+)\./.exec(lines[i]);
    if (h) { area = h[1]; continue; }
    const m = /^([DPN]) \| (.*)$/.exec(lines[i]);
    if (!m) continue;
    const w = want.find((x) => !done.has(x.spec) && x.text === m[2] && (x.area === null || x.area === area));
    if (w) {
      done.add(w.spec);
      if (m[1] !== status) { lines[i] = `${status} | ${m[2]}`; changed = true; }
    }
  }
  if (changed) fs.writeFileSync(p, lines.join(crlf ? "\r\n" : "\n"));
}
const missing = want.filter((x) => !done.has(x.spec));
if (missing.length) { console.error("not found:\n" + missing.map((x) => x.spec).join("\n")); process.exit(1); }
