// Runs the performance benchmark on freshly generated fixtures and deletes them again, also when the run fails:
// the 1M / 10M row files are several GB (more with the DuckDB store the benchmark builds next to them) and must never stay on disk.
//   node tools/perf-run.mjs 1000000 [10000000 ...]        (PERF_EACH=1 for per-query times)
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sizes = process.argv.slice(2);
if (sizes.length === 0) throw new Error("usage: node tools/perf-run.mjs <rows> [<rows> ...]");
let status = 0;
try {
  for (const rows of sizes) {
    const dir = join(root, "target", "perf-fixtures", String(rows));
    let r = spawnSync("node", [join(root, "tools", "dax-fixtures", "generate-large.mjs"), rows], { stdio: "inherit", cwd: root });
    if (r.status === 0) r = spawnSync("cargo", ["run", "--release", "-p", "biforge-engine", "--features", "tools", "--example", "perf_bench", "--", dir], { stdio: "inherit", cwd: root, shell: true });
    if (r.status !== 0) status = r.status ?? 1;
    rmSync(dir, { recursive: true, force: true });
  }
} finally {
  rmSync(join(root, "target", "perf-fixtures"), { recursive: true, force: true });
}
process.exit(status);
