// Modeling edits on the TMDL of a project: properties of tables, columns and measures (format string, summarization,
// sort by column, data category, display folder, hidden, description), calculated columns and tables, hierarchies.
// Pure edits on a Project draft (they run inside DocumentStore.transact).
import type { TableInfo } from "../data/types";
import type { Expr, Project, TmdlNode } from "./types";
import { columnNode, node, text } from "./tables";
import { checkName, findTable, ModelError, requireTable, textProp } from "./ops";

export type Target =
  | { kind: "table"; table: string }
  | { kind: "column"; table: string; column: string }
  | { kind: "measure"; table: string; name: string };

export type PropKey = "description" | "isHidden" | "formatString" | "summarizeBy" | "sortByColumn" | "dataCategory" | "displayFolder" | "isKey";

export const SUMMARIZE_BY = ["none", "sum", "min", "max", "count", "average", "distinctCount"] as const;
export const COLUMN_CATEGORIES = [
  "Address", "City", "Continent", "Country", "County", "Latitude", "Longitude", "Place", "PostalCode", "StateOrProvince", "WebUrl", "ImageUrl", "Barcode",
] as const;

export interface PropSpec {
  key: PropKey;
  on: ("table" | "column" | "measure")[];
  kind: "text" | "flag" | "enum" | "column";
  values?: readonly string[];
}

export const PROPS: PropSpec[] = [
  { key: "description", on: ["table", "column", "measure"], kind: "text" },
  { key: "isHidden", on: ["table", "column", "measure"], kind: "flag" },
  { key: "formatString", on: ["column", "measure"], kind: "text" },
  { key: "summarizeBy", on: ["column"], kind: "enum", values: SUMMARIZE_BY },
  { key: "sortByColumn", on: ["column"], kind: "column" },
  { key: "dataCategory", on: ["table", "column"], kind: "enum", values: [...COLUMN_CATEGORIES, "Time"] },
  { key: "displayFolder", on: ["column", "measure"], kind: "text" },
  { key: "isKey", on: ["column"], kind: "flag" },
];

function nodeOf(p: Project, t: Target): TmdlNode {
  const table = requireTable(p, t.table).node;
  if (t.kind === "table") return table;
  if (t.kind === "column") {
    const c = table.children.find((x) => x.kind === "column" && x.name?.toLowerCase() === t.column.toLowerCase());
    if (!c) throw new ModelError("not-found", `Column "${t.table}[${t.column}]" does not exist.`);
    return c;
  }
  const m = table.children.find((x) => x.kind === "measure" && x.name?.toLowerCase() === t.name.toLowerCase());
  if (!m) throw new ModelError("not-found", `Measure "${t.name}" does not exist in table "${t.table}".`);
  return m;
}

/** Current value of a property: text, true/false for a flag, "" when unset. */
export function getProperty(p: Project, t: Target, key: PropKey): string | boolean {
  const n = nodeOf(p, t);
  if (key === "description") return n.description.join("\n");
  const spec = PROPS.find((s) => s.key === key)!;
  if (spec.kind === "flag") return n.props.some((x) => x.key === key && (x.value === "Flag" || (typeof x.value === "object" && "Text" in x.value && x.value.Text === "true")));
  return textProp(n, key) ?? "";
}

/** Sets a property (null or "" removes it). Throws a message the Properties pane shows when the value is not allowed. */
export function setProperty(p: Project, t: Target, key: PropKey, value: string | boolean | null): void {
  const spec = PROPS.find((s) => s.key === key);
  if (!spec) throw new ModelError("invalid", `"${key}" is not a property BIForge edits.`);
  if (!spec.on.includes(t.kind)) throw new ModelError("invalid", `A ${t.kind} has no "${key}" property.`);
  const n = nodeOf(p, t);
  if (key === "description") {
    n.description = String(value ?? "").split(/\r?\n/).filter((l, i, a) => l.trim() !== "" || i < a.length - 1).map((l) => l.trimEnd());
    if (n.description.every((l) => l === "")) n.description = [];
    return;
  }
  const saved = n.props;
  try {
    applyProp(p, t, n, spec, key, value);
  } catch (e) {
    n.props = saved; // a refused value leaves the property as it was
    throw e;
  }
}

function applyProp(p: Project, t: Target, n: TmdlNode, spec: PropSpec, key: PropKey, value: string | boolean | null): void {
  n.props = n.props.filter((x) => x.key !== key);
  if (spec.kind === "flag") {
    if (value === true) n.props.push({ key, value: "Flag" });
    return;
  }
  const v = value === null || value === false ? "" : String(value).trim();
  if (v === "") return;
  if (spec.kind === "enum" && !spec.values!.some((x) => x.toLowerCase() === v.toLowerCase())) throw new ModelError("invalid", `"${v}" is not a valid ${key}.`);
  if (key === "dataCategory" && t.kind === "table" && v.toLowerCase() !== "time") throw new ModelError("invalid", "A table can only have the data category Time (a date table).");
  if (spec.kind === "column") {
    if (t.kind !== "column") return;
    const table = requireTable(p, t.table).node;
    if (v.toLowerCase() === t.column.toLowerCase()) throw new ModelError("invalid", "A column cannot be sorted by itself.");
    const by = table.children.find((x) => x.kind === "column" && x.name?.toLowerCase() === v.toLowerCase());
    if (!by) throw new ModelError("not-found", `Column "${t.table}[${v}]" does not exist.`);
    // a sort column that is itself sorted by another column would loop
    if (textProp(by, "sortByColumn")?.toLowerCase() === t.column.toLowerCase()) throw new ModelError("invalid", `"${v}" is already sorted by "${t.column}".`);
    n.props.push(text(key, by.name!));
    return;
  }
  const canonical = spec.kind === "enum" ? spec.values!.find((x) => x.toLowerCase() === v.toLowerCase())! : v;
  n.props.push(text(key, canonical));
  if (key === "dataCategory" && t.kind === "table") {
    // a date table needs a key date column: the first date column that is not a key yet becomes it
    const table = n;
    if (!table.children.some((c) => c.kind === "column" && c.props.some((x) => x.key === "isKey"))) {
      const date = table.children.find((c) => c.kind === "column" && textProp(c, "dataType") === "dateTime");
      if (!date) throw new ModelError("invalid", "A date table needs a column of the type Date/Time.");
      date.props.push({ key: "isKey", value: "Flag" });
    }
  }
}

// ---- calculated columns and tables ---------------------------------------------------------------------------

const exprOf = (t: string): Expr => ({ text: t.replace(/\r\n/g, "\n").replace(/\s+$/, ""), verbatim: false });

export function addCalculatedColumn(p: Project, table: string, rawName: string, expression: string, newId: () => string = () => crypto.randomUUID()): void {
  const name = checkName(rawName, "Column");
  if (expression.trim() === "") throw new ModelError("invalid", "Enter the DAX formula of the column.");
  const t = requireTable(p, table).node;
  if (t.children.some((c) => (c.kind === "column" || c.kind === "measure") && c.name?.toLowerCase() === name.toLowerCase())) {
    throw new ModelError("duplicate-name", `Table "${t.name}" already has a column or measure named "${name}".`);
  }
  const c = node("column", name, [text("dataType", "string"), text("lineageTag", newId()), text("summarizeBy", "none")]);
  c.default = exprOf(expression);
  const at = t.children.map((x) => x.kind).lastIndexOf("column");
  t.children.splice(at === -1 ? 0 : at + 1, 0, c);
}

export function setCalculatedColumn(p: Project, table: string, column: string, expression: string): void {
  const c = nodeOf(p, { kind: "column", table, column });
  if (!c.default) throw new ModelError("invalid", `"${column}" is not a calculated column.`);
  if (expression.trim() === "") throw new ModelError("invalid", "Enter the DAX formula of the column.");
  c.default = exprOf(expression);
}

export function calculatedColumns(p: Project, table: string): { name: string; expression: string }[] {
  return requireTable(p, table).node.children.filter((c) => c.kind === "column" && c.default).map((c) => ({ name: c.name!, expression: c.default!.text }));
}

/** Stores the data type the engine found for a calculated column. */
export function setColumnDataType(p: Project, table: string, column: string, dataType: string): void {
  const c = nodeOf(p, { kind: "column", table, column });
  c.props = c.props.filter((x) => x.key !== "dataType");
  c.props.unshift(text("dataType", dataType));
  const sum = c.props.find((x) => x.key === "summarizeBy");
  if (sum && typeof sum.value === "object" && "Text" in sum.value && ["int64", "double", "decimal"].includes(dataType) && sum.value.Text === "none") sum.value = { Text: "sum" };
}

const isCalculatedPartition = (n: TmdlNode) => n.kind === "partition" && n.default?.text.trim().toLowerCase() === "calculated";

export function calculatedTables(p: Project): { name: string; expression: string }[] {
  const out: { name: string; expression: string }[] = [];
  for (const d of Object.values(p.model.tmdl)) {
    for (const n of d.nodes) {
      if (n.kind !== "table" || !n.name) continue;
      const part = n.children.find(isCalculatedPartition);
      const src = part?.props.find((x) => x.key === "source");
      if (part && src && typeof src.value === "object" && "Expr" in src.value) out.push({ name: n.name, expression: src.value.Expr.text });
    }
  }
  return out;
}

/** Creates (or updates, keeping its measures and properties) a calculated table: columns as the engine found them, the DAX in a `calculated` partition. */
export function setCalculatedTable(p: Project, rawName: string, expression: string, info: TableInfo, addTableFn: (p: Project, name: string) => void, newId: () => string = () => crypto.randomUUID()): void {
  const name = checkName(rawName, "Table");
  if (expression.trim() === "") throw new ModelError("invalid", "Enter the DAX expression of the table.");
  let found = findTable(p, name);
  if (found && !found.node.children.some(isCalculatedPartition)) throw new ModelError("duplicate-name", `A table named "${name}" already exists and is not a calculated table.`);
  if (!found) {
    addTableFn(p, name);
    found = findTable(p, name)!;
  }
  const t = found.node;
  const old = new Map(t.children.filter((c) => c.kind === "column").map((c) => [c.name!.toLowerCase(), c]));
  const columns = info.columns.map((c) => columnNode(c.name, c.biType, newId, old.get(c.name.toLowerCase())));
  const others = t.children.filter((c) => c.kind !== "column" && !isCalculatedPartition(c));
  const part = node("partition", name, [text("mode", "import"), { key: "source", value: { Expr: exprOf(expression) } }]);
  part.default = { text: "calculated", verbatim: false };
  t.children = [...columns, ...others, part];
}

// ---- hierarchies -----------------------------------------------------------------------------------------------

export interface HierarchyView {
  name: string;
  levels: { name: string; column: string }[];
}

export function listHierarchies(p: Project, table: string): HierarchyView[] {
  const t = findTable(p, table)?.node;
  if (!t) return [];
  return t.children
    .filter((c) => c.kind === "hierarchy" && c.name)
    .map((h) => ({ name: h.name!, levels: h.children.filter((l) => l.kind === "level").map((l) => ({ name: l.name ?? "", column: textProp(l, "column") ?? l.name ?? "" })) }));
}

export function addHierarchy(p: Project, table: string, rawName: string, columns: string[], newId: () => string = () => crypto.randomUUID()): void {
  const name = checkName(rawName, "Hierarchy");
  const t = requireTable(p, table).node;
  if (columns.length < 2) throw new ModelError("invalid", "A hierarchy needs at least two levels.");
  if (new Set(columns.map((c) => c.toLowerCase())).size !== columns.length) throw new ModelError("invalid", "A column can be used for one level only.");
  if (t.children.some((c) => ["hierarchy", "column", "measure"].includes(c.kind) && c.name?.toLowerCase() === name.toLowerCase())) {
    throw new ModelError("duplicate-name", `Table "${t.name}" already has an object named "${name}".`);
  }
  const levels = columns.map((c) => {
    const col = t.children.find((x) => x.kind === "column" && x.name?.toLowerCase() === c.toLowerCase());
    if (!col) throw new ModelError("not-found", `Column "${table}[${c}]" does not exist.`);
    return node("level", col.name!, [text("lineageTag", newId()), text("column", col.name!)]);
  });
  t.children.push(node("hierarchy", name, [text("lineageTag", newId())], levels));
}

export function removeHierarchy(p: Project, table: string, name: string): void {
  const t = requireTable(p, table).node;
  const before = t.children.length;
  t.children = t.children.filter((c) => !(c.kind === "hierarchy" && c.name?.toLowerCase() === name.toLowerCase()));
  if (t.children.length === before) throw new ModelError("not-found", `Hierarchy "${name}" does not exist in table "${table}".`);
}

/** Hierarchies are refreshed when a column is removed: a hierarchy that lost a level keeps the remaining levels, and is dropped below two. */
export function pruneHierarchies(p: Project, table: string): void {
  const t = findTable(p, table)?.node;
  if (!t) return;
  const cols = new Set(t.children.filter((c) => c.kind === "column").map((c) => c.name!.toLowerCase()));
  for (const h of t.children.filter((c) => c.kind === "hierarchy")) h.children = h.children.filter((l) => l.kind !== "level" || cols.has((textProp(l, "column") ?? "").toLowerCase()));
  t.children = t.children.filter((c) => c.kind !== "hierarchy" || c.children.filter((l) => l.kind === "level").length >= 2);
}
