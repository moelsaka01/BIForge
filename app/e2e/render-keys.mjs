// Runs the audit cases whose key (visualType.object.prop) matches a pattern, in the real window, after `WRITE_RENDER_CASES=1 UPDATE_RENDERED=1
// npx vitest run src/core/format/coverage.test.ts` has written e2e/_cases/all.json (the indices of all.json change with every regeneration, so
// this looks the cases up by key instead of using results.jsonl). Results go to e2e/_cases/results-keys.jsonl.
//   node e2e/render-keys.mjs "^(donutChart\.(centerBackground\.fit|value\.showBlankAs)|scatterChart\.categoryLabels\..*)$" [more patterns...]
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("./_cases/", import.meta.url));
const all = JSON.parse(readFileSync(dir + "all.json", "utf8"));
const patterns = process.argv.slice(2).map((p) => new RegExp(p));
if (!patterns.length) throw new Error("give at least one key pattern");
const ids = [];
all.forEach((c, i) => {
  if (patterns.some((p) => p.test(`${c.visualType}.${c.object}.${c.prop}`))) ids.push(i);
});
console.log(`${ids.length} cases`);
const out = dir + "results-keys.jsonl";
rmSync(out, { force: true });
const BATCH = Number(process.env.RENDER_BATCH ?? 40);
let failed = 0;
for (let i = 0; i < ids.length; i += BATCH) {
  const r = spawnSync(process.execPath, ["e2e/render.mjs"], { env: { ...process.env, RENDER_IDS: ids.slice(i, i + BATCH).join(","), RENDER_OUT: out, RENDER_IMG: dir + "img" }, encoding: "utf8", cwd: fileURLToPath(new URL("../", import.meta.url)) });
  for (const l of (r.stdout ?? "").split("\n")) if (/^(FAIL|DOM|NODATA|EVAL|ERROR|ok)/.test(l)) console.log(l);
  if (r.status !== 0) failed++;
}
const results = readFileSync(out, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const by = {};
for (const r of results) by[r.status] = (by[r.status] ?? 0) + 1;
console.log(JSON.stringify(by));
process.exit(failed ? 1 : 0);
