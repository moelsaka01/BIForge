// Generates a deterministic large Sales table (same columns and dimensions as tests/dax/fixtures) for the
// performance benchmark. The dimension files are copied unchanged.
// Usage (repo root): node tools/dax-fixtures/generate-large.mjs <rows> [outDir]
//   default outDir: target/perf-fixtures/<rows>   (target/ is gitignored; never commit these files)
import { copyFileSync, createWriteStream, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const rows = Number(process.argv[2] ?? 1_000_000);
const out = process.argv[3] ?? join(root, "target", "perf-fixtures", String(rows));
mkdirSync(out, { recursive: true });
for (const f of ["Date", "Customer", "Product", "Promotion", "Budget"]) copyFileSync(join(root, "tests", "dax", "fixtures", `${f}.csv`), join(out, `${f}.csv`));

let seed = 20261023;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const LIST = [1200.0, 850.5, 300.0, 45.99, 9.5, 25.0, 59.99, 19.99];
const day0 = Date.UTC(2023, 0, 1);
const iso = (n) => new Date(day0 + n * 86400000).toISOString().slice(0, 10);
const isoCache = Array.from({ length: 740 }, (_, i) => iso(i));
const channels = ["Store", "Online", "Online"];
const promos = [1, 1, 1, 2, 3];
const discounts = [0, 0.05, 0.1];

const ws = createWriteStream(join(out, "Sales.csv"));
ws.write("SalesKey,OrderDate,ShipDate,CustomerKey,ProductKey,PromotionKey,Quantity,UnitPrice,Discount,Channel\r\n");
let buf = [];
for (let i = 1; i <= rows; i++) {
  const o = int(0, 730);
  const p = int(0, 7);
  const price = Math.round(LIST[p] * (0.9 + rnd() * 0.2) * 100) / 100;
  const disc = rnd() < 0.35 ? "" : discounts[int(0, 2)];
  buf.push(`${i},${isoCache[o]},${isoCache[o + int(1, 6)]},${int(1, 9)},${p + 1},${promos[int(0, 4)]},${int(1, 5)},${price},${disc},${channels[int(0, 2)]}`);
  if (buf.length >= 20000) {
    if (!ws.write(buf.join("\r\n") + "\r\n")) await once(ws, "drain");
    buf = [];
  }
}
if (buf.length) ws.write(buf.join("\r\n") + "\r\n");
ws.end();
await once(ws, "finish");
console.log(`wrote ${rows} Sales rows to ${out}`);
