// Sets the status of hand-written inventory items (manual-*.txt) by exact text: node tools/inventory/flip.mjs D "Ctrl+N new" "Ctrl+O open"
// A status D means Done-tested: only flip an item when an automated test for it passes.
import fs from "node:fs";
import path from "node:path";
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const [status, ...texts] = process.argv.slice(2);
if (!["D", "P", "N"].includes(status) || texts.length === 0) throw new Error('usage: flip.mjs <D|P|N> "item text" ...');
const files = fs.readdirSync(here).filter((f) => /^manual-\d+\.txt$/.test(f));
const missing = new Set(texts);
for (const f of files) {
  const p = path.join(here, f);
  const raw = fs.readFileSync(p, "utf8");
  const crlf = raw.includes("\r\n");
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const m = /^([DPN]) \| (.*)$/.exec(lines[i]);
    if (m && missing.has(m[2])) {
      if (m[1] !== status) { lines[i] = `${status} | ${m[2]}`; changed = true; }
      missing.delete(m[2]);
    }
  }
  if (changed) fs.writeFileSync(p, lines.join(crlf ? "\r\n" : "\n"));
}
if (missing.size) { console.error("not found:\n" + [...missing].join("\n")); process.exit(1); }
