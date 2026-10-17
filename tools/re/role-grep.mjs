// Our own helper: prints short context slices around a term in the visual bundles of an installed Desktop.
//   node tools/re/role-grep.mjs <scripts dir> <regex> [width] [max]
import fs from "node:fs";
import path from "node:path";
const [, , dir, re, w = "160", max = "12"] = process.argv;
const rx = new RegExp(re, "g");
let n = 0;
for (const f of fs.readdirSync(dir).filter((x) => /\.js$/.test(x) && !/^desktopDataExplore/.test(x))) {
  const t = fs.readFileSync(path.join(dir, f), "utf8");
  for (const m of t.matchAll(rx)) {
    if (n++ >= +max) process.exit(0);
    console.log(`${f} @${m.index}: ${t.slice(Math.max(0, m.index - +w), m.index + +w + m[0].length).replace(/\s+/g, " ")}\n`);
  }
}
