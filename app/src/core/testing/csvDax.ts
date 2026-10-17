// Test double for DaxApi that answers the queries of the report builders from the fixture CSV files, for the shapes
// they produce: EVALUATE SUMMARIZECOLUMNS(group columns, FILTER(ALL(col), col IN {...}) filters, "name", AGG(Sales[col])).
// Measures are aggregated over the Sales rows joined to Product, Customer and Date. The expected values in the tests are
// computed from the CSV files separately, so this evaluator only has to be right about these shapes.
import type { Cell, QueryOutcome } from "../dax/types";
import { loadCsv, type Row } from "../report/testFixture";

type Joined = Record<string, Record<string, string>>; // table -> column -> value

function joinedRows(): Joined[] {
  const product = new Map(loadCsv("Product").map((r) => [r.ProductKey, r]));
  const customer = new Map(loadCsv("Customer").map((r) => [r.CustomerKey, r]));
  const date = new Map(loadCsv("Date").map((r) => [r.Date, r]));
  return loadCsv("Sales").map((s: Row) => ({ Sales: s, Product: product.get(s.ProductKey) ?? {}, Customer: customer.get(s.CustomerKey) ?? {}, Date: date.get(s.OrderDate?.slice(0, 10)) ?? {} }));
}

const ROWS = joinedRows();

/** Splits at top-level commas (not inside brackets, braces or quotes). */
function splitArgs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let q = "";
  let cur = "";
  for (const ch of text) {
    if (q) {
      cur += ch;
      if (ch === q) q = "";
      continue;
    }
    if (ch === '"' || ch === "'") q = ch;
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const colRe = /^'?([A-Za-z_ ]+?)'?\[([^\]]+)\]$/;
const col = (s: string): { table: string; name: string } | null => {
  const m = colRe.exec(s.trim());
  return m ? { table: m[1], name: m[2] } : null;
};

const cellOf = (v: string | number | null): Cell => (v === null || v === "" ? { t: "blank", v: "" } : typeof v === "number" ? { t: Number.isInteger(v) ? "int" : "real", v: String(v) } : { t: /^-?\d+$/.test(v) ? "int" : /^-?\d*\.\d+$/.test(v) ? "real" : "text", v });

/** Answers one EVALUATE query; throws for shapes it does not know. */
export function csvDax(query: string): QueryOutcome {
  const values = /^EVALUATE VALUES\((.+?)\)\s*(ORDER BY[\s\S]*)?$/s.exec(query.trim());
  if (values) {
    const c = col(values[1]);
    if (!c) throw new Error(`csvDax cannot answer: ${query}`);
    const distinct = [...new Set(ROWS.map((r) => r[c.table]?.[c.name] ?? ""))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return { results: [{ columns: [`${c.table}[${c.name}]`], rows: distinct.map((v) => [cellOf(v)]), totalRows: distinct.length, truncated: false }], elapsedMs: 1 };
  }
  const m = /^EVALUATE SUMMARIZECOLUMNS\((.*)\)\s*(ORDER BY[\s\S]*)?$/s.exec(query.trim());
  if (!m) throw new Error(`csvDax cannot answer: ${query}`);
  const groups: { table: string; name: string }[] = [];
  const filters: { table: string; name: string; values: string[] }[] = [];
  const measures: { fn: string; table: string; name: string }[] = [];
  const args = splitArgs(m[1]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const g = col(a);
    const f = /^FILTER\(ALL\((.+?)\),\s*(.+?)\s+IN\s*\{(.*)\}\)$/s.exec(a);
    if (a.startsWith('"')) {
      const e = /^([A-Z.]+)\((.+)\)$/.exec(args[i + 1] ?? "");
      const c = e ? col(e[2]) : null;
      if (!e || !c) throw new Error(`csvDax cannot answer the measure ${args[i + 1]}`);
      measures.push({ fn: e[1], ...c });
      i++;
    } else if (f) {
      const c = col(f[1]);
      if (!c) throw new Error(`csvDax cannot answer the filter ${a}`);
      filters.push({ ...c, values: splitArgs(f[3]).map((x) => x.replace(/^"(.*)"$/, "$1").replace(/""/g, '"')) });
    } else if (g) groups.push(g);
    else throw new Error(`csvDax cannot answer the argument ${a}`);
  }
  const rows = ROWS.filter((r) => filters.every((f) => f.values.includes(r[f.table]?.[f.name] ?? "")));
  const byKey = new Map<string, Joined[]>();
  for (const r of rows) {
    const key = JSON.stringify(groups.map((g) => r[g.table]?.[g.name] ?? ""));
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(r);
  }
  if (groups.length === 0) byKey.set("[]", rows);
  const agg = (fn: string, rs: Joined[], c: { table: string; name: string }): number | null => {
    const xs = rs.map((r) => r[c.table]?.[c.name] ?? "").filter((v) => v !== "");
    const ns = xs.map(Number).filter((x) => Number.isFinite(x));
    switch (fn) {
      case "SUM":
        return ns.reduce((a, b) => a + b, 0);
      case "COUNT":
        return xs.length;
      case "AVERAGE":
        return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : null;
      case "MIN":
        return ns.length ? Math.min(...ns) : null;
      case "MAX":
        return ns.length ? Math.max(...ns) : null;
      case "DISTINCTCOUNT":
        return new Set(xs).size;
      default:
        throw new Error(`csvDax does not know ${fn}`);
    }
  };
  const out = [...byKey.entries()]
    .map(([key, rs]) => ({ key: JSON.parse(key) as string[], cells: [...(JSON.parse(key) as string[]).map((v) => cellOf(v)), ...measures.map((x) => cellOf(agg(x.fn, rs, x)))] }))
    .sort((a, b) => a.key.join("\u0001").localeCompare(b.key.join("\u0001"), undefined, { numeric: true }));
  return { results: [{ columns: [...groups.map((g) => `${g.table}[${g.name}]`), ...measures.map((_, i) => `[m${i}]`)], rows: out.map((o) => o.cells), totalRows: out.length, truncated: false }], elapsedMs: 1 };
}
