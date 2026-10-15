// Generates the DAX harness fixture CSVs into tests/dax/fixtures/ (deterministic; our own synthetic data).
// Usage (repo root): node tools/dax-fixtures/generate.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tests", "dax", "fixtures");
mkdirSync(out, { recursive: true });

// Small deterministic PRNG (LCG), so every run writes identical files.
let seed = 20261015;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const csvCell = (v) => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function write(name, header, rows) {
  const text = [header.join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\r\n") + "\r\n";
  writeFileSync(join(out, name), text, "utf8");
  console.log(`${name}: ${rows.length} rows`);
}

// ---- Date: contiguous 2023-01-01 .. 2024-12-31 --------------------------------------------------
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const start = new Date(Date.UTC(2023, 0, 1));
const end = new Date(Date.UTC(2024, 11, 31));
const dates = [];
for (let d = start; d <= end; d = addDays(d, 1)) {
  const m = d.getUTCMonth();
  const dow = ((d.getUTCDay() + 6) % 7) + 1; // Monday = 1 .. Sunday = 7
  dates.push([iso(d), d.getUTCFullYear(), `Q${Math.floor(m / 3) + 1}`, m + 1, MONTHS[m], d.getUTCFullYear() * 100 + m + 1, dow, dow >= 6 ? "TRUE" : "FALSE"]);
}
write("Date.csv", ["Date", "Year", "Quarter", "MonthNumber", "Month", "YearMonth", "DayOfWeek", "IsWeekend"], dates);

// ---- Customer ------------------------------------------------------------------------------------
const customers = [
  [1, "Alice", "Seattle", "United States", "Consumer", "1985-03-12"],
  [2, "Bruno", "Lyon", "France", "Corporate", "1979-11-02"],
  [3, "Chen", "Toronto", "Canada", "Consumer", null],
  [4, "Dana", "Seattle", "United States", "Home Office", "1992-07-30"],
  [5, "Émile", "Paris", "France", "Consumer", "2000-01-01"],
  [6, "Farah", "Toronto", "Canada", "Corporate", "1988-05-19"],
  [7, "Goran", "Berlin", "Germany", "Consumer", "1970-12-31"],
  [8, "Hana", "Berlin", "Germany", null, "1995-02-28"],
  [9, "Ivan", "Portland", "United States", "Corporate", "1983-09-09"],
  [10, "Jun", "Osaka", "Japan", "Home Office", "1990-04-04"], // never buys anything
];
write("Customer.csv", ["CustomerKey", "Customer", "City", "Country", "Segment", "BirthDate"], customers);

// ---- Product -------------------------------------------------------------------------------------
const products = [
  [1, "Trail Bike", "Bikes", "Mountain", "Red", 1200.0, 700.0],
  [2, "City Bike", "Bikes", "Road", "Blue", 850.5, 500.25],
  [3, "Kids Bike", "Bikes", "Road", null, 300.0, 180.0],
  [4, "Helmet", "Accessories", "Safety", "Black", 45.99, 20.0],
  [5, "Bottle", "Accessories", "Hydration", "Blue", 9.5, 2.75],
  [6, "Lights", "Accessories", "Safety", "Black", 25.0, 11.4],
  [7, "Jersey", "Clothing", "Tops", "Red", 59.99, 25.0],
  [8, "Gloves", "Clothing", "Hands", "Black", 19.99, 7.5],
  [9, "Rain Jacket", "Clothing", "Tops", "Yellow", 120.0, 60.0], // never sold
];
write("Product.csv", ["ProductKey", "Product", "Category", "Subcategory", "Color", "ListPrice", "Cost"], products);

// ---- Promotion (related to Sales with a BOTH-direction relationship) -------------------------------
const promotions = [
  [1, "No Promotion", 0],
  [2, "Spring Sale", 0.1],
  [3, "Black Friday", 0.25],
  [4, "Clearance", 0.4], // never used
];
write("Promotion.csv", ["PromotionKey", "Promotion", "DiscountPct"], promotions);

// ---- Sales ---------------------------------------------------------------------------------------
const sold = products.slice(0, 8);
const sales = [];
const N = 240;
for (let i = 1; i <= N; i++) {
  const order = addDays(start, int(0, 730));
  const p = pick(sold);
  let customerKey = int(1, 9);
  let productKey = p[0];
  let quantity = int(1, 5);
  let ship = iso(addDays(order, int(1, 6)));
  let discount = rnd() < 0.35 ? null : pick([0, 0.05, 0.1]);
  const promo = pick([1, 1, 1, 2, 3]);
  const price = Math.round(p[5] * (0.9 + rnd() * 0.2) * 100) / 100;
  // edge cases at fixed positions
  if (i === 17) customerKey = 99; // customer not in Customer (blank row on the one side)
  if (i === 33) productKey = null; // blank foreign key
  if (i === 50 || i === 51) ship = null; // not shipped yet
  if (i === 77) quantity = -2; // a return
  if (i === 90) quantity = null; // missing quantity
  if (i === 120) discount = 0;
  sales.push([i, iso(order), ship, customerKey, productKey, promo, quantity, price, discount, pick(["Store", "Online", "Online"])]);
}
// one order on the last day whose ship date falls after the Date table (inactive relationship misses it)
sales.push([N + 1, "2024-12-31", "2025-01-03", 1, 4, 1, 1, 45.99, null, "Online"]);
write("Sales.csv", ["SalesKey", "OrderDate", "ShipDate", "CustomerKey", "ProductKey", "PromotionKey", "Quantity", "UnitPrice", "Discount", "Channel"], sales);

// ---- Budget (no relationships; used with TREATAS) --------------------------------------------------
const budget = [];
for (const y of [2023, 2024]) for (const c of ["Bikes", "Accessories", "Clothing"]) budget.push([y, c, c === "Bikes" ? 40000 + (y - 2023) * 5000 : c === "Accessories" ? 3000 : 4500]);
write("Budget.csv", ["Year", "Category", "BudgetAmount"], budget);
