// Generates the data of the "Learn with sample data" project into app/src-tauri/sample/ (deterministic; our own
// synthetic cycle-shop data, no edge cases). Usage (repo root): node tools/sample-data/generate.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "app", "src-tauri", "sample");
mkdirSync(out, { recursive: true });
let seed = 4242;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const csv = (name, header, rows) => {
  const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  writeFileSync(join(out, name), [header.join(","), ...rows.map((r) => r.map(cell).join(","))].join("\n") + "\n", "utf8");
  console.log(`${name}: ${rows.length} rows`);
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const start = new Date(Date.UTC(2023, 0, 1));
const dates = [];
for (let d = start; d <= new Date(Date.UTC(2024, 11, 31)); d = addDays(d, 1)) {
  const m = d.getUTCMonth();
  dates.push([iso(d), d.getUTCFullYear(), `Q${Math.floor(m / 3) + 1}`, m + 1, MONTHS[m], d.getUTCFullYear() * 100 + m + 1]);
}
csv("Date.csv", ["Date", "Year", "Quarter", "MonthNumber", "Month", "YearMonth"], dates);

const regions = [["Nordic", "Oslo"], ["Iberia", "Madrid"], ["Alps", "Zurich"], ["Benelux", "Utrecht"], ["Baltic", "Riga"], ["Balkans", "Sofia"]];
const customers = Array.from({ length: 24 }, (_, i) => {
  const r = regions[i % regions.length];
  return [i + 1, `Customer ${String(i + 1).padStart(2, "0")}`, r[1], r[0], pick(["Retail", "Club", "Corporate"])];
});
csv("Customer.csv", ["CustomerKey", "Customer", "City", "Region", "Segment"], customers);

const products = [
  [1, "Ridge Mountain Bike", "Bikes", "Mountain", 1450, 880],
  [2, "Harbor Road Bike", "Bikes", "Road", 1100, 650],
  [3, "Pebble Kids Bike", "Bikes", "Kids", 320, 190],
  [4, "Orbit Helmet", "Accessories", "Safety", 59, 24],
  [5, "Flow Bottle", "Accessories", "Hydration", 12, 3.5],
  [6, "Beam Light Set", "Accessories", "Safety", 34, 14],
  [7, "Crest Jersey", "Clothing", "Tops", 72, 28],
  [8, "Grip Gloves", "Clothing", "Hands", 24, 9],
];
csv("Product.csv", ["ProductKey", "Product", "Category", "Subcategory", "ListPrice", "Cost"], products);

const sales = [];
for (let i = 1; i <= 400; i++) {
  const p = pick(products);
  const order = addDays(start, int(0, 730));
  const qty = int(1, p[2] === "Bikes" ? 3 : 6);
  const price = Math.round(p[4] * (0.92 + rnd() * 0.16) * 100) / 100;
  sales.push([i, iso(order), int(1, customers.length), p[0], qty, price, pick(["Store", "Online", "Online"])]);
}
csv("Sales.csv", ["SalesKey", "OrderDate", "CustomerKey", "ProductKey", "Quantity", "UnitPrice", "Channel"], sales);
