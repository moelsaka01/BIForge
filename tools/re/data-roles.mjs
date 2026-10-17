// Our own helper: lists the data role names of the visual capability definitions in the bundles of an installed
// Power BI Desktop. Raw output goes to research/_raw (gitignored); the role names (a file-format fact) are kept in
// app/src/core/report/visualRoles.json, which the test visualRoles.test.ts compares with the app's visual catalog.
//
//   node tools/re/data-roles.mjs <minerva scripts dir> [out file]
//
// A definition is `dataRoles:[ {name:<literal or K.key>, kind:...}, ... ]`. A `name:K.key` reference is resolved by
// looking for `key:"Value"` in the same bundle; all candidates are listed, so ambiguous ones are visible.
import fs from "node:fs";
import path from "node:path";

const [, , dir, out = "research/_raw/data-roles.txt"] = process.argv;
if (!dir) throw new Error("usage: node data-roles.mjs <scripts dir> [out]");
const lines = [];
for (const f of fs.readdirSync(dir).filter((n) => /\.js$/.test(n) && !/^desktopDataExplore|\.json\./.test(n))) {
  const t = fs.readFileSync(path.join(dir, f), "utf8");
  for (const m of t.matchAll(/dataRoles:\[/g)) {
    let i = m.index + m[0].length - 1, depth = 0, j = i;
    for (; j < t.length; j++) {
      const c = t[j];
      if (c === "[") depth++;
      else if (c === "]" && --depth === 0) break;
    }
    const body = t.slice(i, j + 1);
    const names = [];
    // top-level elements only: `{name:` right after `[` or `},`
    for (const x of body.matchAll(/(?:\[|\},)\{name:("([A-Za-z0-9_]+)"|[A-Za-z_$][\w$]*(?:\.[\w$]+)*\.([\w$]+))/g)) {
      if (x[2]) names.push(x[2]);
      else {
        const key = x[3];
        const c = new Set([...t.matchAll(new RegExp(`[{,]${key.replace(/\$/g, "\\$")}:"([A-Za-z0-9_]+)"`, "g"))].map((y) => y[1]));
        names.push(c.size ? [...c].join("|") : `?${key}`);
      }
    }
    if (!names.length) continue;
    const before = t.slice(Math.max(0, m.index - 300), m.index);
    const vt = [...before.matchAll(/\b(?:visualType|name|id)\s*[:=]\s*"([A-Za-z]+)"/g)].map((y) => y[1]).pop() ?? "";
    lines.push(`${f}\t@${m.index}\t[${names.join(", ")}]\t${vt}`);
  }
}
fs.writeFileSync(out, lines.join("\n"));
console.log(lines.length, "definitions ->", out);
