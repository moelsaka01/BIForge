// Quick measures: a calculation chosen from a list and the fields it works on, written as an ordinary DAX measure.
// The templates are plain text; tests/model/quick-measures.json (written by the tests) lists the expansions that the Rust
// engine runs over the fixture, so a template that is not valid DAX for BIForge's engine is found there.

export type QuickKind =
  | "average" | "max" | "min" | "sum" | "count" | "distinctCount"
  | "runningTotal" | "percentOfTotal" | "ytd" | "qtd" | "mtd" | "yoy" | "yoyPercent" | "sameLastYear" | "rollingAverage";

export interface QuickSpec {
  kind: QuickKind;
  /** The value column or measure that is aggregated: `Table[Column]` (a column) or `[Measure]`. */
  base: string;
  /** For the per-category calculations and running totals: the column that defines the categories. */
  category?: string;
  /** For the time calculations: the date column `Date[Date]`. */
  date?: string;
  /** Rolling average: how many periods. */
  periods?: number;
  periodUnit?: "DAY" | "MONTH" | "YEAR";
}

export interface QuickDef {
  kind: QuickKind;
  label: string;
  group: "Aggregate per category" | "Running total" | "Totals" | "Time intelligence";
  needs: ("category" | "date" | "periods")[];
  /** Base can be a measure (a measure reference), not only a column. */
  measureBase: boolean;
}

export const QUICK_MEASURES: QuickDef[] = [
  { kind: "sum", label: "Sum per category", group: "Aggregate per category", needs: ["category"], measureBase: false },
  { kind: "average", label: "Average per category", group: "Aggregate per category", needs: ["category"], measureBase: false },
  { kind: "max", label: "Maximum per category", group: "Aggregate per category", needs: ["category"], measureBase: false },
  { kind: "min", label: "Minimum per category", group: "Aggregate per category", needs: ["category"], measureBase: false },
  { kind: "count", label: "Count of values per category", group: "Aggregate per category", needs: ["category"], measureBase: false },
  { kind: "distinctCount", label: "Count of distinct values per category", group: "Aggregate per category", needs: ["category"], measureBase: false },
  { kind: "runningTotal", label: "Running total", group: "Running total", needs: ["category"], measureBase: true },
  { kind: "percentOfTotal", label: "Percent of grand total", group: "Totals", needs: [], measureBase: true },
  { kind: "ytd", label: "Year-to-date total", group: "Time intelligence", needs: ["date"], measureBase: true },
  { kind: "qtd", label: "Quarter-to-date total", group: "Time intelligence", needs: ["date"], measureBase: true },
  { kind: "mtd", label: "Month-to-date total", group: "Time intelligence", needs: ["date"], measureBase: true },
  { kind: "sameLastYear", label: "Same period last year", group: "Time intelligence", needs: ["date"], measureBase: true },
  { kind: "yoy", label: "Year-over-year change", group: "Time intelligence", needs: ["date"], measureBase: true },
  { kind: "yoyPercent", label: "Year-over-year % change", group: "Time intelligence", needs: ["date"], measureBase: true },
  { kind: "rollingAverage", label: "Rolling average", group: "Time intelligence", needs: ["date", "periods"], measureBase: true },
];

const isMeasureRef = (s: string) => /^\[[^\]]+\]$/.test(s.trim());

/** `Sales[Amount]` or `'My Table'[Col]` -> the table and column, or null. */
export function splitColumn(ref: string): { table: string; column: string } | null {
  const m = /^\s*(?:'((?:[^']|'')+)'|([A-Za-z_][\w ]*?))\s*\[([^\]]+)\]\s*$/.exec(ref);
  if (!m) return null;
  return { table: (m[1] ?? m[2]).replace(/''/g, "'"), column: m[3] };
}

/** A name for the measure, from the calculation and the fields. */
export function quickName(s: QuickSpec): string {
  const def = QUICK_MEASURES.find((d) => d.kind === s.kind)!;
  const base = splitColumn(s.base)?.column ?? s.base.replace(/^\[|\]$/g, "");
  const cat = s.category ? splitColumn(s.category)?.column : undefined;
  switch (s.kind) {
    case "sum": return `${base} sum per ${cat}`;
    case "average": return `${base} average per ${cat}`;
    case "max": return `${base} max per ${cat}`;
    case "min": return `${base} min per ${cat}`;
    case "count": return `${base} count per ${cat}`;
    case "distinctCount": return `Distinct ${base} per ${cat}`;
    case "runningTotal": return `${base} running total in ${cat}`;
    case "percentOfTotal": return `${base} % of grand total`;
    case "ytd": return `${base} YTD`;
    case "qtd": return `${base} QTD`;
    case "mtd": return `${base} MTD`;
    case "sameLastYear": return `${base} PY`;
    case "yoy": return `${base} YoY change`;
    case "yoyPercent": return `${base} YoY %`;
    case "rollingAverage": return `${base} ${s.periods ?? 3}-${(s.periodUnit ?? "MONTH").toLowerCase()} rolling average`;
    default: return def.label;
  }
}

/** The DAX of the measure. Throws a message the dialog shows when a field is missing or of the wrong kind. */
export function quickExpression(s: QuickSpec): string {
  const def = QUICK_MEASURES.find((d) => d.kind === s.kind);
  if (!def) throw new Error("Choose a calculation.");
  const baseMeasure = isMeasureRef(s.base);
  if (!s.base.trim()) throw new Error("Choose the base value.");
  if (!baseMeasure && !splitColumn(s.base)) throw new Error(`"${s.base}" is not a column (Table[Column]) or a measure ([Measure]).`);
  if (baseMeasure && !def.measureBase) throw new Error("This calculation needs a column as its base value, not a measure.");
  // the value that is aggregated: a measure as it is, a column summed
  const value = baseMeasure ? s.base.trim() : `SUM(${s.base.trim()})`;
  const need = (what: "category" | "date") => {
    const f = s[what];
    if (!f || !splitColumn(f)) throw new Error(what === "category" ? "Choose the category column." : "Choose the date column.");
    return f.trim();
  };
  switch (s.kind) {
    case "sum":
    case "average":
    case "max":
    case "min": {
      const cat = need("category");
      const fn = { sum: "SUMX", average: "AVERAGEX", max: "MAXX", min: "MINX" }[s.kind];
      return `${fn}(VALUES(${cat}), CALCULATE(${value}))`;
    }
    case "count":
      return `COUNTX(VALUES(${need("category")}), CALCULATE(${value}))`;
    case "distinctCount": {
      const cat = need("category");
      if (baseMeasure) throw new Error("Count of distinct values needs a column.");
      return `CALCULATE(DISTINCTCOUNT(${s.base.trim()}), ALLSELECTED(${cat}))`;
    }
    case "runningTotal": {
      const cat = need("category");
      return `CALCULATE(${value}, FILTER(ALLSELECTED(${cat}), ${cat} <= MAX(${cat})))`;
    }
    case "percentOfTotal":
      return `DIVIDE(${value}, CALCULATE(${value}, ALLSELECTED()))`;
    case "ytd":
      return `TOTALYTD(${value}, ${need("date")})`;
    case "qtd":
      return `TOTALQTD(${value}, ${need("date")})`;
    case "mtd":
      return `TOTALMTD(${value}, ${need("date")})`;
    case "sameLastYear":
      return `CALCULATE(${value}, SAMEPERIODLASTYEAR(${need("date")}))`;
    case "yoy": {
      const d = need("date");
      return `VAR __prev = CALCULATE(${value}, SAMEPERIODLASTYEAR(${d}))\nRETURN\nIF(NOT ISBLANK(__prev), ${value} - __prev)`;
    }
    case "yoyPercent": {
      const d = need("date");
      return `VAR __prev = CALCULATE(${value}, SAMEPERIODLASTYEAR(${d}))\nRETURN\nDIVIDE(${value} - __prev, __prev)`;
    }
    case "rollingAverage": {
      const d = need("date");
      const n = Math.round(s.periods ?? 0);
      if (!(n >= 1)) throw new Error("Enter how many periods the average covers (at least 1).");
      const unit = s.periodUnit ?? "MONTH";
      return `AVERAGEX(DATESINPERIOD(${d}, MAX(${d}), -${n}, ${unit}), CALCULATE(${value}))`;
    }
  }
}
