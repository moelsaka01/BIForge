// Usage: node scan-strings.mjs <dir> <term> [term...]  -> per-file hit counts (UTF-8 and UTF-16LE), top 30.
import fs from "node:fs";
import path from "node:path";
const [, , dir, ...terms] = process.argv;
const rows = [];
for (const f of fs.readdirSync(dir)) {
  if (!/\.(dll|exe)$/i.test(f)) continue;
  const buf = fs.readFileSync(path.join(dir, f));
  const hits = {};
  for (const t of terms) {
    let c = 0;
    for (const enc of ["utf8", "utf16le"]) {
      const needle = Buffer.from(t, enc);
      let i = 0;
      while ((i = buf.indexOf(needle, i)) !== -1) { c++; i += needle.length; }
    }
    hits[t] = c;
  }
  const total = Object.values(hits).reduce((a, b) => a + b, 0);
  if (total) rows.push([f, (buf.length / 1048576).toFixed(1) + "MB", JSON.stringify(hits), total]);
}
rows.sort((a, b) => b[3] - a[3]).slice(0, 30).forEach((r) => console.log(r.slice(0, 3).join("  ")));
