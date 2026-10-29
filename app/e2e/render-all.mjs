// Full render audit: every drawn property (e2e/_cases/all.json, written by
// `WRITE_RENDER_CASES=1 UPDATE_RENDERED=1 npx vitest run src/core/format/coverage.test.ts`) is compared in the real window,
// BATCH cases per app launch, WORKERS launches at a time. Results are appended to e2e/_cases/results.jsonl and a finished
// case is not run again, so an interrupted run resumes. Run: node e2e/render-all.mjs   [RENDER_WORKERS=4 RENDER_BATCH=40 RENDER_FROM=0 RENDER_TO=n]
// Needs `npx tauri build --debug --no-bundle` first. Only the processes started here are ever stopped (by PID).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("./_cases/", import.meta.url));
const all = JSON.parse(readFileSync(join(dir, "all.json"), "utf8"));
const WORKERS = Number(process.env.RENDER_WORKERS ?? 4);
const BATCH = Number(process.env.RENDER_BATCH ?? 40);
const FROM = Number(process.env.RENDER_FROM ?? 0);
const TO = Math.min(all.length, Number(process.env.RENDER_TO ?? all.length));
const outFile = join(dir, "results.jsonl");
const done = new Set();
if (!existsSync(outFile)) writeFileSync(outFile, "");
for (const l of readFileSync(outFile, "utf8").split("\n")) if (l.trim()) done.add(JSON.parse(l).idx);

const run = (args, env) => new Promise((resolve) => {
  const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  child.on("exit", (code) => resolve({ code, out }));
});

const base = mkdtempSync(join(tmpdir(), "biforge-render-base-"));
mkdirSync(base, { recursive: true });
const made = await run(["e2e/render.mjs"], { RENDER_MAKE_BASE: base, RENDER_PORT: "9500" });
if (!/BASE READY/.test(made.out)) { console.log(made.out); throw new Error("could not create the sample project"); }

const batches = [];
const IDS = process.env.RENDER_IDS?.split(",").map(Number);
let IDS_FORCE = false;
if (IDS) for (let k = 0; k < IDS.length; k += BATCH) batches.push(IDS.slice(k, k + BATCH));
else for (let a = FROM; a < TO; a += BATCH) {
  const b = Math.min(TO, a + BATCH);
  if (all.slice(a, b).every((_, k) => done.has(a + k))) continue;
  batches.push([a, b]);
}
console.log(`${batches.length} batches of up to ${BATCH}, ${WORKERS} at a time`);
let next = 0;
const worker = async (w) => {
  while (next < batches.length) {
    const [a, b] = (IDS || IDS_FORCE) ? [batches[next][0], batches[next][batches[next].length - 1] + 1] : batches[next];
    const list = (IDS || IDS_FORCE) ? batches[next].join(",") : null;
    next++;
    const r = await run(["e2e/render.mjs"], { RENDER_BASE: base, ...(list ? { RENDER_IDS: list } : { RENDER_RANGE: `${a}-${b}` }), RENDER_OUT: outFile, RENDER_PORT: String(9510 + w * 4) });
    const got = r.out.match(/^(ok|FAIL|DOM-ONLY|NODATA|SKIP-\w+) /gm)?.length ?? 0;
    console.log(`[w${w}] ${a}-${b}: exit ${r.code}, ${got} results${r.code && got < b - a ? "\n" + r.out.split("\n").slice(-8).join("\n") : ""}`);
  }
};
await Promise.all(Array.from({ length: WORKERS }, (_, w) => worker(w)));

// a case that does not look different under load (four windows at a time) is tried again alone: only a second failure counts
const latest = () => { const m = new Map(); for (const l of readFileSync(outFile, "utf8").split("\n")) if (l.trim()) { const r = JSON.parse(l); m.set(r.idx, r); } return m; };
const badIds = () => [...latest().values()].filter((r) => /^(FAIL|DOM-ONLY|NODATA)$/.test(r.status)).map((r) => r.idx).sort((x, y) => x - y);
const again = badIds();
if (again.length && WORKERS > 1) {
  console.log(`${again.length} cases tried again, one window at a time`);
  batches.length = 0;
  for (let k = 0; k < again.length; k += 15) batches.push(again.slice(k, k + 15));
  next = 0;
  IDS_FORCE = true;
  await worker(0);
}

const tally = {};
for (const l of readFileSync(outFile, "utf8").split("\n")) if (l.trim()) { const r = JSON.parse(l); tally[r.status] = (tally[r.status] ?? 0) + 1; }
console.log("DONE", JSON.stringify(tally));
