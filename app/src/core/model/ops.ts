// Pure edits on a Project draft. They throw ModelError on invalid input; DocumentStore.transact
// applies them to a clone and discards the clone on error, so a failed edit changes nothing.
import type { Expr, Project, TmdlDocument, TmdlNode } from "./types";

export type ModelErrorCode = "invalid-name" | "duplicate-name" | "not-found" | "invalid";

export class ModelError extends Error {
  constructor(
    public code: ModelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ModelError";
  }
}

/** Same rules as biforge_model::project::sanitize_file_name. */
export function sanitizeFileName(name: string): string {
  let s = Array.from(name)
    .map((c) => (c.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(c) ? "_" : c))
    .join("");
  s = s.replace(/[. ]+$/, "");
  if (s === "") s = "_";
  const stem = s.toUpperCase().split(".")[0];
  if (/^(CON|PRN|AUX|NUL|COM\d|LPT\d)$/.test(stem)) s = "_" + s;
  return s;
}

const MODEL_FILE = "model.tmdl";

function isTable(n: TmdlNode): boolean {
  return n.kind === "table";
}

export function findTable(p: Project, name: string): { key: string; node: TmdlNode } | undefined {
  for (const [key, doc] of Object.entries(p.model.tmdl)) {
    const n = doc.nodes.find((x) => isTable(x) && x.name?.toLowerCase() === name.toLowerCase());
    if (n) return { key, node: n };
  }
  return undefined;
}

export function requireTable(p: Project, name: string) {
  const t = findTable(p, name);
  if (!t) throw new ModelError("not-found", `Table "${name}" does not exist.`);
  return t;
}

export function checkName(name: string, what: string): string {
  const n = name.trim();
  if (n === "") throw new ModelError("invalid-name", `${what} name cannot be empty.`);
  if (/[\r\n\t]/.test(n)) throw new ModelError("invalid-name", `${what} name cannot contain line breaks or tabs.`);
  return n;
}

export function allTables(p: Project): TmdlNode[] {
  return Object.values(p.model.tmdl).flatMap((d) => d.nodes.filter(isTable));
}

function uniqueTablePath(p: Project, name: string): string {
  const base = sanitizeFileName(name);
  const taken = new Set(Object.keys(p.model.tmdl).map((k) => k.toLowerCase()));
  let key = `tables/${base}.tmdl`;
  for (let i = 2; taken.has(key.toLowerCase()); i++) key = `tables/${base} (${i}).tmdl`;
  return key;
}

function modelDoc(p: Project): TmdlDocument {
  const doc = p.model.tmdl[MODEL_FILE];
  if (!doc) throw new ModelError("not-found", "The project has no model.tmdl file.");
  return doc;
}

export function addTable(p: Project, rawName: string, newId: () => string = () => crypto.randomUUID()): void {
  const name = checkName(rawName, "Table");
  if (findTable(p, name)) throw new ModelError("duplicate-name", `A table named "${name}" already exists.`);
  const node: TmdlNode = {
    description: [],
    kind: "table",
    name,
    default: null,
    props: [{ key: "lineageTag", value: { Text: newId() } }],
    children: [],
  };
  p.model.tmdl[uniqueTablePath(p, name)] = { nodes: [node] };
  const doc = modelDoc(p);
  const ref: TmdlNode = { description: [], kind: "ref table", name, default: null, props: [], children: [] };
  let at = doc.nodes.map((n) => n.kind).lastIndexOf("ref table");
  at = at === -1 ? 1 : at + 1;
  doc.nodes.splice(at, 0, ref);
}

/** Splits `Table.Column` / `'My Table'.'My Col'` into its parts. */
export function parseColumnRef(s: string): { table: string; column: string } | null {
  let i = 0;
  const readPart = (): string | null => {
    if (s[i] === "'") {
      let out = "";
      i++;
      while (i < s.length) {
        if (s[i] === "'") {
          if (s[i + 1] === "'") {
            out += "'";
            i += 2;
            continue;
          }
          i++;
          return out;
        }
        out += s[i++];
      }
      return null;
    }
    const start = i;
    while (i < s.length && s[i] !== ".") i++;
    return s.slice(start, i);
  };
  const table = readPart();
  if (table === null || s[i] !== ".") return null;
  i++;
  const column = readPart();
  return column === null ? null : { table, column };
}

export function textProp(n: TmdlNode, key: string): string | null {
  const p = n.props.find((x) => x.key === key);
  return p && typeof p.value === "object" && "Text" in p.value ? p.value.Text : null;
}

function relationshipTables(n: TmdlNode): string[] {
  return ["fromColumn", "toColumn"].flatMap((k) => {
    const v = textProp(n, k);
    const r = v ? parseColumnRef(v) : null;
    return r ? [r.table.toLowerCase()] : [];
  });
}

export function deleteTable(p: Project, name: string): void {
  const { key, node } = requireTable(p, name);
  const tn = node.name!.toLowerCase();
  delete p.model.tmdl[key];
  const doc = modelDoc(p);
  doc.nodes = doc.nodes.filter((n) => !(n.kind === "ref table" && n.name?.toLowerCase() === tn));
  for (const d of Object.values(p.model.tmdl)) {
    d.nodes = d.nodes.filter((n) => !(n.kind === "relationship" && relationshipTables(n).includes(tn)));
  }
  for (const k of Object.keys(p.model.tmdl)) {
    if (k.endsWith("relationships.tmdl") && p.model.tmdl[k].nodes.length === 0) delete p.model.tmdl[k];
  }
}

function measureOwner(p: Project, measure: string): { table: TmdlNode; m: TmdlNode } | undefined {
  for (const t of allTables(p)) {
    const m = t.children.find((c) => c.kind === "measure" && c.name?.toLowerCase() === measure.toLowerCase());
    if (m) return { table: t, m };
  }
  return undefined;
}

function cleanExpression(text: string): Expr {
  return { text: text.replace(/\r\n/g, "\n").replace(/\s+$/, ""), verbatim: false };
}

export function addMeasure(p: Project, table: string, rawName: string, expression: string): void {
  const name = checkName(rawName, "Measure");
  const { node } = requireTable(p, table);
  const dup = measureOwner(p, name);
  if (dup) throw new ModelError("duplicate-name", `A measure named "${name}" already exists (in table "${dup.table.name}").`);
  if (node.children.some((c) => c.kind === "column" && c.name?.toLowerCase() === name.toLowerCase())) {
    throw new ModelError("duplicate-name", `Table "${node.name}" already has a column named "${name}".`);
  }
  node.children.push({ description: [], kind: "measure", name, default: cleanExpression(expression), props: [], children: [] });
}

export function setMeasureExpression(p: Project, measure: string, expression: string): void {
  const found = measureOwner(p, measure);
  if (!found) throw new ModelError("not-found", `Measure "${measure}" does not exist.`);
  found.m.default = cleanExpression(expression);
}

export function deleteMeasure(p: Project, measure: string): void {
  const found = measureOwner(p, measure);
  if (!found) throw new ModelError("not-found", `Measure "${measure}" does not exist.`);
  found.table.children = found.table.children.filter((c) => c !== found.m);
}

// ---- read-only views for the UI ----

export interface TableView {
  name: string;
  columns: { name: string; dataType: string | null; summarizeBy: string | null }[];
  measures: { name: string; expression: string }[];
}

export function listTables(p: Project): TableView[] {
  return allTables(p).map((t) => ({
    name: t.name ?? "",
    columns: t.children
      .filter((c) => c.kind === "column")
      .map((c) => ({ name: c.name ?? "", dataType: textProp(c, "dataType"), summarizeBy: textProp(c, "summarizeBy") })),
    measures: t.children
      .filter((c) => c.kind === "measure")
      .map((c) => ({ name: c.name ?? "", expression: c.default?.text ?? "" })),
  }));
}

// ---- model settings (Options > Current File > Regional Settings) ----

/** The culture (language) of the model, from `model.tmdl`; null when the file or property is missing. */
export function getModelCulture(p: Project): string | null {
  const n = p.model.tmdl[MODEL_FILE]?.nodes.find((x) => x.kind === "model");
  return n ? textProp(n, "culture") : null;
}

export function setModelCulture(p: Project, raw: string): void {
  const culture = raw.trim();
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(culture)) throw new ModelError("invalid-name", `"${raw}" is not a culture name such as en-US.`);
  const n = p.model.tmdl[MODEL_FILE]?.nodes.find((x) => x.kind === "model");
  if (!n) throw new ModelError("not-found", "The model has no model.tmdl.");
  const prop = n.props.find((x) => x.key === "culture");
  if (prop) prop.value = { Text: culture };
  else n.props.unshift({ key: "culture", value: { Text: culture } });
}
