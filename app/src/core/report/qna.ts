// Q&A: a question in plain words becomes a small visual. The reader types "sales by category" and gets a column chart.
// This is a parser for a short list of question shapes, not a language model; it matches the words to the names of the
// measures, columns and tables of the model (and the synonyms the model lists). Pure.
import { agg, column, measure, type AggFn, type FieldRef } from "./fields";
import type { ModelInfo } from "./modelInfo";

export interface Answer {
  type: "card" | "clusteredColumnChart" | "clusteredBarChart" | "lineChart" | "pieChart" | "table";
  roles: Record<string, FieldRef[]>;
  /** For "top 5 products by sales": keep the first n by the value, largest first. */
  top?: { n: number; dir: "top" | "bottom"; by: FieldRef };
  /** The question as the answer understood it, shown under the input. */
  restated: string;
  /** Something the answer had to guess (a number summed, a column counted), shown as a note. */
  assumed?: string;
}
export type Parsed = { ok: true; answer: Answer } | { ok: false; message: string };

export const QNA_EXAMPLES = ["total quantity by category", "average unit price by country", "top 5 products by quantity", "quantity", "count of customers by country"];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const stem = (w: string) => (w.length > 3 && w.endsWith("ies") ? w.slice(0, -3) + "y" : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
// "UnitPrice" and "unit_price" are read as "unit price"
const key = (s: string) => norm(s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ")).split(" ").map(stem).join(" ");

interface Cand {
  field: FieldRef;
  names: string[];
  isMeasure: boolean;
  numeric: boolean;
  date: boolean;
}

function candidates(model: ModelInfo): Cand[] {
  const out: Cand[] = [];
  for (const t of model.tables()) {
    for (const m of model.measures(t)) out.push({ field: measure(t, m), names: [key(m)], isMeasure: true, numeric: true, date: false });
    for (const c of model.columns(t)) {
      const dt = model.columnType(t, c);
      out.push({ field: column(t, c), names: [key(c), key(`${t} ${c}`)], isMeasure: false, numeric: dt === "int64" || dt === "double" || dt === "decimal", date: dt === "dateTime" });
    }
  }
  return out;
}

/** The candidate a phrase names: the whole phrase, else the one whose name is the longest part of it. Measures win over columns of the same name. */
function find(phrase: string, cands: Cand[], want?: (c: Cand) => boolean): Cand | null {
  const k = key(phrase);
  if (!k) return null;
  const ok = (c: Cand) => !want || want(c);
  const exact = cands.filter((c) => ok(c) && c.names.includes(k));
  if (exact.length) return exact.find((c) => c.isMeasure) ?? exact[0];
  // a name that is part of the phrase (the longest first), or a name the phrase is part of (the closest first); measures first
  let best: { c: Cand; score: number } | null = null;
  for (const c of cands) {
    if (!ok(c)) continue;
    for (const n of c.names) {
      if (!n) continue;
      const inPhrase = ` ${k} `.includes(` ${n} `);
      const phraseIn = ` ${n} `.includes(` ${k} `);
      if (!inPhrase && !phraseIn) continue;
      const score = (c.isMeasure ? 1000 : 0) + (inPhrase ? 100 + n.length : 50 - n.length);
      if (!best || score > best.score) best = { c, score };
    }
  }
  return best?.c ?? null;
}

const AGG_WORDS: [RegExp, AggFn, string][] = [
  [/^(?:total|sum of|sum)\s+/, 0, "total"],
  [/^(?:average|avg|mean|average of)\s+/, 1, "average"],
  [/^(?:distinct count of|unique|number of distinct|count distinct)\s+/, 2, "distinct count of"],
  [/^(?:minimum|min|lowest|smallest)\s+/, 3, "minimum"],
  [/^(?:maximum|max|highest|largest|biggest)\s+/, 4, "maximum"],
  [/^(?:count of|number of|count|how many)\s+/, 5, "count of"],
];

/** A value phrase ("total quantity", "unit price", "count of customers") as a measure or an aggregated column. */
function valueField(phrase: string, cands: Cand[]): { field: FieldRef; text: string; guessed?: boolean } | null {
  let p = norm(phrase);
  let fn: AggFn | null = null;
  let word = "";
  for (const [re, f, w] of AGG_WORDS) {
    const m = re.exec(p);
    if (m) {
      fn = f;
      word = w;
      p = p.slice(m[0].length);
      break;
    }
  }
  const c = find(p, cands, fn === 5 || fn === 2 ? undefined : (x) => x.isMeasure || x.numeric);
  if (!c) return null;
  if (c.isMeasure) return { field: c.field, text: fieldName(c.field) };
  if (fn === null && !c.numeric) return null;
  const useFn: AggFn = fn ?? 0;
  const cf = c.field as { table: string; name: string };
  return { field: agg(cf.table, cf.name, useFn), text: `${fn === null ? "total" : word} ${cf.name}`, guessed: fn === null };
}

const fieldName = (f: FieldRef): string => ("name" in f ? (f as { name: string }).name : "");

/** Reads a question. */
export function parseQuestion(question: string, model: ModelInfo): Parsed {
  const q = norm(question);
  if (!q) return { ok: false, message: "Type a question about your data, for example: " + QNA_EXAMPLES[0] };
  const cands = candidates(model);

  // top / bottom N <category> by <value>
  let m = /^(top|bottom|best|worst)\s+(\d+)?\s*(.+?)\s+(?:by|per|for)\s+(.+)$/.exec(q);
  if (m) {
    const cat = find(m[3], cands, (c) => !c.isMeasure);
    const val = valueField(m[4], cands);
    if (!cat) return { ok: false, message: `I did not find a column called "${m[3]}".` };
    if (!val) return { ok: false, message: `I did not find a number called "${m[4]}".` };
    const dir = m[1] === "top" || m[1] === "best" ? "top" : "bottom";
    const n = m[2] ? Number(m[2]) : 5;
    return { ok: true, answer: { type: "clusteredBarChart", roles: { Category: [cat.field], Y: [val.field] }, top: { n, dir, by: val.field }, restated: `${dir === "top" ? "Top" : "Bottom"} ${n} ${fieldName(cat.field)} by ${val.text}` } };
  }

  // <values> by <category>
  m = /^(.+?)\s+(?:by|per|for each|across|grouped by|broken down by)\s+(.+)$/.exec(q);
  if (m) {
    const parts = m[1].split(/\s*(?:,| and )\s*/).filter(Boolean);
    const vals = parts.map((p) => valueField(p, cands));
    const bad = vals.findIndex((v) => !v);
    if (bad >= 0) return { ok: false, message: `I did not find a measure or number called "${parts[bad]}".` };
    const cat = find(m[2], cands, (c) => !c.isMeasure);
    if (!cat) return { ok: false, message: `I did not find a column called "${m[2]}".` };
    const fields = vals.map((v) => v!.field);
    const type = cat.date ? "lineChart" : /\b(share|percent|percentage|proportion)\b/.test(q) && fields.length === 1 ? "pieChart" : "clusteredColumnChart";
    return { ok: true, answer: { type, roles: { Category: [cat.field], Y: fields }, restated: `${vals.map((v) => v!.text).join(" and ")} by ${fieldName(cat.field)}`, ...(vals.some((v) => v!.guessed) ? { assumed: "Numbers that are not measures are added up." } : {}) } };
  }

  // a single value
  const v = valueField(q, cands);
  if (v) return { ok: true, answer: { type: "card", roles: { Values: [v.field] }, restated: v.text } };

  // a column on its own is a list of its values
  const c = find(q, cands, (x) => !x.isMeasure);
  if (c) return { ok: true, answer: { type: "table", roles: { Values: [c.field] }, restated: `Values of ${fieldName(c.field)}` } };
  return { ok: false, message: `I did not understand "${question.trim()}". Try: ${QNA_EXAMPLES.slice(0, 3).join(" | ")}` };
}
