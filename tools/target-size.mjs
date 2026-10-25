// Prints the size of target/ by folder and says when it is over the limit (15 GB). Run it at the start and the end of a session.
//   node tools/target-size.mjs          report only (exit code 1 when over the limit)
// If it is over the limit, run `cargo clean` at a safe point: no build, test, e2e run or harness of this session is running.
import { readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LIMIT = 15 * 1024 ** 3;
const target = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "target");
function size(p) {
  let total = 0;
  for (const e of readdirSync(p, { withFileTypes: true })) {
    const f = join(p, e.name);
    try { total += e.isDirectory() ? size(f) : statSync(f).size; } catch { /* a file that vanished */ }
  }
  return total;
}
if (!existsSync(target)) { console.log("target/ does not exist (0 GB)"); process.exit(0); }
const gb = (n) => (n / 1024 ** 3).toFixed(2) + " GB";
let all = 0;
for (const e of readdirSync(target, { withFileTypes: true })) {
  const n = e.isDirectory() ? size(join(target, e.name)) : statSync(join(target, e.name)).size;
  all += n;
  if (n > 50 * 1024 ** 2) console.log(`  ${e.name.padEnd(22)} ${gb(n)}`);
}
console.log(`target/ ${gb(all)} (limit ${gb(LIMIT)})`);
if (all > LIMIT) { console.log("OVER THE LIMIT: run cargo clean at a safe point."); process.exit(1); }
