// Column From Examples: finds an M expression over the columns of a row that produces the example values the user typed.
// The search space is small and explicit (case changes, characters from the start / end / the middle, text before / after a
// delimiter, parts of dates, and concatenations of those with literal text), every candidate is evaluated here on the sample
// rows, and the first one that gives every example wins (simplest first). No engine round trip; the chosen expression is
// written as an ordinary custom column, so what runs is the M shown.

export interface ExampleColumn {
  name: string;
  /** "text", "number", "date" (yyyy-mm-dd values) or "other". */
  kind: "text" | "number" | "date" | "other";
}

/** One expression: `m` is its M text, `run` evaluates it on a row (values by column name, null = null). */
interface Program {
  m: string;
  run(row: Record<string, string | null>): string | null;
  /** Rough size, to prefer the simplest. */
  cost: number;
}

const ref = (c: string) => (/^[A-Za-z_][\w ]*$/.test(c) && !/ {2}/.test(c) && c === c.trim() ? `[${c}]` : `[#"${c.replace(/"/g, '""')}"]`);
const mtext = (s: string) => `"${s.replace(/"/g, '""')}"`;
const proper = (s: string) => s.replace(/[\p{L}\p{N}]+/gu, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function dateParts(s: string): { y: number; m: number; d: number; dow: number } | null {
  const x = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!x) return null;
  const y = Number(x[1]);
  const m = Number(x[2]);
  const d = Number(x[3]);
  return { y, m, d, dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}

/** Programs that read one column (text values; a number is its text; a date is its yyyy-mm-dd text). */
function columnPrograms(c: ExampleColumn, samples: (string | null)[]): Program[] {
  const r = ref(c.name);
  const get = (row: Record<string, string | null>) => row[c.name] ?? null;
  const out: Program[] = [];
  const add = (m: string, f: (v: string) => string | null, cost: number) =>
    out.push({ m, cost, run: (row) => { const v = get(row); return v === null ? null : f(v); } });
  if (c.kind === "date") {
    const part = (m: string, f: (p: NonNullable<ReturnType<typeof dateParts>>) => string) => add(m, (v) => { const p = dateParts(v); return p ? f(p) : null; }, 2);
    part(`Text.From(Date.Year(${r}))`, (p) => String(p.y));
    part(`Text.From(Date.Month(${r}))`, (p) => String(p.m));
    part(`Text.From(Date.Day(${r}))`, (p) => String(p.d));
    part(`Text.From(Date.Quarter(${r}))`, (p) => String(Math.ceil(p.m / 3)));
    part(`Date.MonthName(${r})`, (p) => MONTHS[p.m - 1]);
    part(`Text.Start(Date.MonthName(${r}), 3)`, (p) => MONTHS[p.m - 1].slice(0, 3));
    part(`Date.DayOfWeekName(${r})`, (p) => DAYS[p.dow]);
    part(`Text.Start(Date.DayOfWeekName(${r}), 3)`, (p) => DAYS[p.dow].slice(0, 3));
    part(`Date.ToText(${r}, "yyyy-MM")`, (p) => `${String(p.y).padStart(4, "0")}-${String(p.m).padStart(2, "0")}`);
    part(`Date.ToText(${r}, "MM/dd/yyyy")`, (p) => `${String(p.m).padStart(2, "0")}/${String(p.d).padStart(2, "0")}/${p.y}`);
    part(`Date.ToText(${r}, "dd MMM yyyy")`, (p) => `${String(p.d).padStart(2, "0")} ${MONTHS[p.m - 1].slice(0, 3)} ${p.y}`);
    part(`Date.ToText(${r}, "MMM yyyy")`, (p) => `${MONTHS[p.m - 1].slice(0, 3)} ${p.y}`);
  }
  const text = c.kind === "text" ? r : `Text.From(${r})`;
  add(text, (v) => v, 1);
  if (c.kind !== "text" && c.kind !== "other") return out;
  add(`Text.Upper(${text})`, (v) => v.toUpperCase(), 2);
  add(`Text.Lower(${text})`, (v) => v.toLowerCase(), 2);
  add(`Text.Proper(${text})`, proper, 2);
  add(`Text.Trim(${text})`, (v) => v.trim(), 2);
  add(`Text.From(Text.Length(${text}))`, (v) => String(v.length), 3);
  const maxLen = Math.max(0, ...samples.map((s) => s?.length ?? 0));
  for (let n = 1; n <= Math.min(maxLen, 12); n++) {
    add(`Text.Start(${text}, ${n})`, (v) => v.slice(0, n), 3);
    add(`Text.End(${text}, ${n})`, (v) => (v.length >= n ? v.slice(-n) : v), 3);
    add(`Text.Upper(Text.Start(${text}, ${n}))`, (v) => v.slice(0, n).toUpperCase(), 4);
    add(`Text.Range(${text}, 1, ${n})`, (v) => (v.length >= 1 + n ? v.slice(1, 1 + n) : null), 5);
    add(`Text.RemoveRange(${text}, 0, ${n})`, (v) => (v.length >= n ? v.slice(n) : null), 4);
    add(`Text.RemoveRange(${text}, Text.Length(${text}) - ${n}, ${n})`, (v) => (v.length >= n ? v.slice(0, v.length - n) : null), 5);
  }
  // delimiters: the punctuation and spaces that occur in the samples
  const delims = new Set<string>();
  for (const s of samples) for (const ch of s ?? "") if (!/[\p{L}\p{N}]/u.test(ch)) delims.add(ch);
  for (const d of delims) {
    const q = mtext(d);
    add(`Text.BeforeDelimiter(${text}, ${q})`, (v) => (v.includes(d) ? v.slice(0, v.indexOf(d)) : null), 3);
    add(`Text.AfterDelimiter(${text}, ${q})`, (v) => (v.includes(d) ? v.slice(v.indexOf(d) + d.length) : null), 3);
    add(`Text.BeforeDelimiter(${text}, ${q}, {0, RelativePosition.FromEnd})`, (v) => (v.includes(d) ? v.slice(0, v.lastIndexOf(d)) : null), 4);
    add(`Text.AfterDelimiter(${text}, ${q}, {0, RelativePosition.FromEnd})`, (v) => (v.includes(d) ? v.slice(v.lastIndexOf(d) + d.length) : null), 4);
    add(`Text.Upper(Text.Start(Text.AfterDelimiter(${text}, ${q}), 1))`, (v) => (v.includes(d) ? v.slice(v.indexOf(d) + d.length).slice(0, 1).toUpperCase() : null), 6);
  }
  return out;
}

const equals = (a: string | null, b: string) => a !== null && a === b;

/**
 * Finds the simplest expression that gives `examples[i]` on `rows[i]` for every example (row index to the expected text).
 * Returns the M text, or null when nothing in the search space fits.
 */
export interface Suggestion {
  /** M expression over the columns of a row (for an added custom column). */
  formula: string;
  /** What it gives for every row (null = null). */
  values: (string | null)[];
}

export function suggestFormula(columns: ExampleColumn[], rows: (string | null)[][], examples: Map<number, string>): Suggestion | null {
  const found = search(columns, rows, examples);
  if (!found) return null;
  const toRow = (r: (string | null)[]) => Object.fromEntries(columns.map((c, i) => [c.name, r[i] ?? null])) as Record<string, string | null>;
  return { formula: found.m, values: rows.map((r) => found.run(toRow(r))) };
}

function search(columns: ExampleColumn[], rows: (string | null)[][], examples: Map<number, string>): Program | null {
  if (examples.size === 0) return null;
  const toRow = (r: (string | null)[]) => Object.fromEntries(columns.map((c, i) => [c.name, r[i] ?? null])) as Record<string, string | null>;
  const exRows = [...examples.keys()].map((i) => ({ row: toRow(rows[i]), want: examples.get(i)! }));
  const fits = (p: Program) => exRows.every((e) => equals(p.run(e.row), e.want));
  const singles: Program[] = columns.flatMap((c, ci) => columnPrograms(c, rows.map((r) => r[ci])));
  const good = singles.filter(fits).sort((a, b) => a.cost - b.cost)[0];
  if (good) return good;
  // concatenations: parts are programs (cost <= 3) and literal separators taken from the first example
  const parts = singles.filter((p) => p.cost <= 2);
  const first = exRows[0];
  const concat = (acc: Program | null, depth: number, rest: string): Program | null => {
    if (rest === "" && acc) return fits(acc) ? acc : null;
    if (depth >= 5) return null;
    // a literal that runs until the next program output, or an output of a program at the start of `rest`
    for (const p of parts) {
      const v = p.run(first.row);
      if (!v || !rest.startsWith(v)) continue;
      const next: Program = acc
        ? { m: `${acc.m} & ${p.m}`, cost: acc.cost + p.cost, run: (row) => { const a = acc.run(row); const b = p.run(row); return a === null || b === null ? null : a + b; } }
        : p;
      const got = concat(next, depth + 1, rest.slice(v.length));
      if (got) return got;
    }
    // literal text up to the next program output (or the end)
    for (let n = 1; n <= rest.length; n++) {
      const lit = rest.slice(0, n);
      const after = rest.slice(n);
      const startsProgram = after === "" || parts.some((p) => { const v = p.run(first.row); return !!v && after.startsWith(v); });
      if (!startsProgram) continue;
      const next: Program = acc
        ? { m: `${acc.m} & ${mtext(lit)}`, cost: acc.cost + 1, run: (row) => { const a = acc.run(row); return a === null ? null : a + lit; } }
        : { m: mtext(lit), cost: 1, run: () => lit };
      const got = concat(next, depth + 1, after);
      if (got) return got;
    }
    return null;
  };
  const joined = concat(null, 0, first.want);
  if (joined) return joined;
  // a constant is a valid answer only when every example is the same text
  const wants = new Set(exRows.map((e) => e.want));
  if (wants.size === 1) {
    const lit = [...wants][0];
    return { m: mtext(lit), cost: 1, run: () => lit };
  }
  return null;
}
