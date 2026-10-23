// Test double for MApi. It does not evaluate M: it understands the canonical `let` layout the real tools write
// (four-space indented steps) well enough to exercise the editor's state handling, and returns tables that tests register.
import type { ColumnInfo, RowPage, TableInfo } from "../data/types";
import type { Applied, ColumnProfile, MApi, MDiagnostic, ParsedQuery, ParsedStep, StepEdit, StepResult, Transform, ValueOut, DataTypeName } from "../queries/types";

export interface FakeTable {
  columns: ColumnInfo[];
  rows: (string | null)[][];
  /** (row, column) of error cells */
  errorCells?: [number, number][];
}

const rawName = (n: string) => (/^[A-Za-z_]\w*$/.test(n) ? n : `#"${n}"`);
const plainName = (r: string) => (r.startsWith('#"') ? r.slice(2, -1) : r);

export function parseCanonical(text: string): ParsedQuery {
  const m = /^let\n([\s\S]*)\nin\n(?: {4}|\t)([\s\S]*)$/.exec(text.trim());
  if (!m) throw new Error("This query is not a let ... in expression, so it has no applied steps.");
  const steps: ParsedStep[] = [];
  const re = /^(?: {4}|\t)(#"[^"]+"|\w+) = ([\s\S]*?)(?:,\n(?=(?: {4}|\t)(?:#"[^"]+"|\w+) = )|$)/gm;
  let x: RegExpExecArray | null;
  const body = m[1];
  while ((x = re.exec(body)) && x[0] !== "") {
    const expr = x[2];
    steps.push({ name: plainName(x[1]), rawName: x[1], expr, function: /^([A-Za-z.]+)\(/.exec(expr)?.[1] ?? null });
    if (re.lastIndex >= body.length) break;
  }
  return { steps, output: m[2] };
}

export function buildCanonical(steps: { rawName: string; expr: string }[], output: string): string {
  return `let\n${steps.map((s) => `    ${s.rawName} = ${s.expr}`).join(",\n")}\nin\n    ${output}`;
}

const duckType = (t?: string) => (t === "int64" ? "BIGINT" : t === "double" ? "DOUBLE" : t === "boolean" ? "BOOLEAN" : t === "dateTime" ? "DATE" : "VARCHAR");

export class FakeM implements MApi {
  calls: string[] = [];
  tables = new Map<string, FakeTable>();
  /** Columns a step shows in the analysis, by query then step; defaults to the query's registered table. */
  stepColumns = new Map<string, Map<string, string[]>>();
  failLoad = new Map<string, string>();
  stepErrors = new Map<string, string>(); // "query/step" -> message
  folderText = 'let\n    Source = Folder.Files("C:/data")\nin\n    Source';

  parseQuery = async (text: string): Promise<ParsedQuery> => parseCanonical(text);

  check = async (text: string): Promise<MDiagnostic[]> => (text.includes("(((") ? [{ start: 0, end: 3, message: "Unexpected token." }] : []);

  applyTransform = async (text: string, after: string | null, t: Transform): Promise<Applied> => {
    this.calls.push(`transform:${t.kind}:${after ?? "end"}`);
    const q = parseCanonical(text);
    const anchor = after ?? q.steps[q.steps.length - 1].name;
    const base = t.kind[0].toUpperCase() + t.kind.slice(1);
    let name = base;
    for (let i = 1; q.steps.some((s) => s.name === name); i++) name = `${base}${i}`;
    const out = await this.editStep(text, { op: "insert", after: anchor, name, expr: `Fake.${t.kind}(${rawName(anchor)})` });
    return { text: out, added: [name] };
  };

  editStep = async (text: string, e: StepEdit): Promise<string> => {
    this.calls.push(`edit:${e.op}`);
    if (e.op === "renameRef") return text.split(new RegExp(`\\b${e.old}\\b`)).join(e.new);
    const q = parseCanonical(text);
    let steps = q.steps.map((s) => ({ ...s }));
    let output = q.output;
    if (e.op === "insert") {
      const at = e.after ? steps.findIndex((s) => s.name === e.after) : steps.length - 1;
      if (at < 0) throw new Error(`The step "${e.after}" does not exist.`);
      const anchor = rawName(steps[at].name);
      steps = steps.map((s, i) => (i > at ? { ...s, expr: s.expr.split(anchor).join(rawName(e.name)) } : s));
      steps.splice(at + 1, 0, { name: e.name, rawName: rawName(e.name), expr: e.expr, function: null });
      output = output.split(anchor).join(rawName(e.name));
    } else if (e.op === "delete") {
      const at = steps.findIndex((s) => s.name === e.name);
      if (at <= 0) throw new Error(`The step "${e.name}" cannot be deleted.`);
      const prev = rawName(steps[at - 1].name);
      steps = steps.filter((_, i) => i !== at).map((s) => ({ ...s, expr: s.expr.split(rawName(e.name)).join(prev) }));
      output = output.split(rawName(e.name)).join(prev);
    } else if (e.op === "deleteFrom") {
      const at = steps.findIndex((s) => s.name === e.name);
      if (at <= 0) throw new Error(`The step "${e.name}" cannot be deleted.`);
      steps = steps.slice(0, at);
      output = rawName(steps[steps.length - 1].name);
    } else if (e.op === "rename") {
      steps = steps.map((s) => ({ ...s, name: s.name === e.old ? e.new : s.name, rawName: s.name === e.old ? rawName(e.new) : s.rawName, expr: s.expr.split(rawName(e.old)).join(rawName(e.new)) }));
      output = output.split(rawName(e.old)).join(rawName(e.new));
    } else if (e.op === "setExpr") {
      steps = steps.map((s) => (s.name === e.name ? { ...s, expr: e.expr } : s));
    } else if (e.op === "move") {
      const at = steps.findIndex((s) => s.name === e.name);
      const to = at + e.delta;
      if (at < 0 || to < 0 || to >= steps.length) throw new Error("The step cannot move further.");
      const [s] = steps.splice(at, 1);
      steps.splice(to, 0, s);
    }
    return buildCanonical(steps, output);
  };

  dependencies = async (queries: Record<string, string>): Promise<Record<string, string[]>> => {
    const out: Record<string, string[]> = {};
    for (const [n, t] of Object.entries(queries)) out[n] = Object.keys(queries).filter((o) => o !== n && new RegExp(`\\b${o}\\b`).test(t));
    return out;
  };

  folderQuery = async (): Promise<string> => this.folderText;

  analyze = async (queries: Record<string, string>, query: string): Promise<StepResult[]> => {
    this.calls.push(`analyze:${query}`);
    const q = parseCanonical(queries[query]);
    const table = this.tables.get(query);
    return q.steps.map((s) => {
      const err = this.stepErrors.get(`${query}/${s.name}`);
      const names = this.stepColumns.get(query)?.get(s.name) ?? table?.columns.map((c) => c.name) ?? [];
      return err
        ? { name: s.name, kind: "error", columns: [], error: { reason: "Expression.Error", message: err } }
        : this.values.has(`${query}/${s.name}`) ? { name: s.name, kind: this.values.get(`${query}/${s.name}`)!.kind, columns: [], error: null }
        : { name: s.name, kind: "table", columns: names.map((n) => ({ name: n, duckdbType: duckType(table?.columns.find((c) => c.name === n)?.biType) })), error: null };
    });
  };

  preview = async (queries: Record<string, string>, query: string, step: string | null, limit: number): Promise<RowPage> => {
    this.calls.push(`preview:${query}:${step ?? "end"}:${limit}`);
    const err = this.stepErrors.get(`${query}/${step ?? ""}`);
    if (err) throw new Error(err);
    const t = this.tables.get(query);
    if (!t) throw new Error(`The query "${query}" does not exist.`);
    return { columns: t.columns, rows: t.rows.slice(0, limit), total: t.rows.length, ...(t.errorCells ? { errorCells: t.errorCells } : {}) };
  };

  profile = async (queries: Record<string, string>, query: string, step: string | null, limit: number | null): Promise<ColumnProfile[]> => {
    this.calls.push(`profile:${query}:${step ?? "end"}:${limit ?? "all"}`);
    const t = this.tables.get(query);
    if (!t) throw new Error(`The query "${query}" does not exist.`);
    const rows = limit === null ? t.rows : t.rows.slice(0, limit);
    return t.columns.map((c, i) => {
      const vals = rows.map((r) => r[i]);
      const nonNull = vals.filter((v): v is string => v !== null && v !== "");
      const counts = new Map<string | null, number>();
      for (const v of vals) counts.set(v, (counts.get(v) ?? 0) + 1);
      const nums = nonNull.map(Number).filter((n) => Number.isFinite(n));
      const numeric = c.biType === "int64" || c.biType === "double" || c.biType === "decimal";
      return {
        name: c.name,
        duckdbType: duckType(c.biType),
        rows: rows.length,
        valid: nonNull.length,
        empty: rows.length - nonNull.length,
        error: 0,
        distinct: new Set(vals.filter((v) => v !== null)).size,
        unique: [...counts.entries()].filter(([k, n]) => k !== null && n === 1).length,
        min: nonNull.length ? [...nonNull].sort()[0] : null,
        max: nonNull.length ? [...nonNull].sort().at(-1)! : null,
        average: numeric && nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null,
        stdDev: null,
        top: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20),
        rowsLimited: limit !== null && t.rows.length > limit,
      };
    });
  };

  load = async (queries: Record<string, string>, query: string, table: string): Promise<TableInfo> => {
    this.calls.push(`load:${query}->${table}`);
    const fail = this.failLoad.get(query);
    if (fail) throw new Error(fail);
    const t = this.tables.get(query);
    if (!t) throw new Error(`The query "${query}" does not exist.`);
    return { name: table, columns: t.columns, rowCount: t.rows.length };
  };

  /** What detectTypes answers, by column name (columns not listed keep "text"). */
  detected = new Map<string, DataTypeName>();

  detectTypes = async (queries: Record<string, string>, query: string, step: string | null, columns: string[]) => {
    this.calls.push(`detectTypes:${query}:${step ?? "end"}:${columns.join("|")}`);
    return columns.map((column) => ({ column, type: this.detected.get(column) ?? ("text" as DataTypeName) }));
  };

  /** Steps ("query/step") and whole queries ("query/") whose value is not a table. */
  values = new Map<string, ValueOut>();

  value = async (queries: Record<string, string>, query: string, step: string | null): Promise<ValueOut> => {
    this.calls.push(`value:${query}:${step ?? "end"}`);
    const v = this.values.get(`${query}/${step ?? ""}`) ?? this.values.get(`${query}/`);
    if (!v) throw new Error("The value is a table.");
    return v;
  };

  queryKinds = async (queries: Record<string, string>): Promise<Record<string, string>> => Object.fromEntries(Object.keys(queries).map((k) => [k, this.values.get(`${k}/`)?.kind ?? "table"]));
}
