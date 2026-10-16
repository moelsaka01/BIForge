// Pure edits for imported tables: columns come from the engine, the source description is kept in an annotation.
import type { Project, TmdlNode } from "./types";
import type { SourceSpec, TableInfo, BiType, ColumnInfo } from "../data/types";
import { partitionM } from "./partitionM";
import { addTable, findTable, textProp } from "./ops";
import { removeRelationshipsOnColumns } from "./relationships";

const SOURCE_ANNOTATION = "BIForge.Source";

export const node = (kind: string, name: string | null, props: TmdlNode["props"] = [], children: TmdlNode[] = []): TmdlNode => ({
  description: [],
  kind,
  name,
  default: null,
  props,
  children,
});

export const text = (key: string, v: string) => ({ key, value: { Text: v } });

export function columnNode(name: string, t: BiType, newId: () => string, existing?: TmdlNode): TmdlNode {
  if (existing) {
    // Refresh keeps user-edited properties (format, description, lineageTag, ...) and only updates what the source defines.
    const c = structuredClone(existing);
    c.props = c.props.filter((p) => p.key !== "dataType" && p.key !== "sourceColumn");
    c.props.unshift(text("dataType", t), text("sourceColumn", name));
    return c;
  }
  const props = [text("dataType", t), text("lineageTag", newId())];
  if (t === "string" || t === "dateTime" || t === "boolean" || t === "binary") props.push(text("summarizeBy", "none"));
  props.push(text("sourceColumn", name));
  return node("column", name, props);
}

const GENERATED_ANNOTATION = "BIForge.GeneratedM";

/** The import partition: M source that Power BI Desktop can run to load the same data. */
function generatedPartition(table: string, source: SourceSpec, columns: ColumnInfo[]): TmdlNode {
  const marker = node("annotation", GENERATED_ANNOTATION);
  marker.default = { text: "true", verbatim: false };
  const p = node(
    "partition",
    table,
    [text("mode", "import"), { key: "source", value: { Expr: { text: partitionM(source, columns), verbatim: false } } }],
    [marker],
  );
  p.default = { text: "m", verbatim: false };
  return p;
}

export interface ImportResult {
  created: boolean;
  /** Relationships dropped because a column they used no longer exists in the source. */
  removedRelationships: string[];
}

/** Creates the table (or updates it on refresh) from an engine table description. */
export function applyImport(
  p: Project,
  info: TableInfo,
  source: SourceSpec,
  newId: () => string = () => crypto.randomUUID(),
): ImportResult {
  let found = findTable(p, info.name);
  const created = !found;
  if (!found) {
    addTable(p, info.name, newId);
    found = findTable(p, info.name)!;
  }
  const t = found.node;
  const oldColumns = new Map(t.children.filter((c) => c.kind === "column").map((c) => [c.name!.toLowerCase(), c]));
  const fresh = new Set(info.columns.map((c) => c.name.toLowerCase()));
  const gone = [...oldColumns.values()].filter((c) => !fresh.has(c.name!.toLowerCase())).map((c) => c.name!);
  const isGenerated = (c: TmdlNode) => c.kind === "partition" && c.children.some((a) => a.kind === "annotation" && a.name === GENERATED_ANNOTATION);
  const isOwnPartition = (c: TmdlNode) => c.kind === "partition" && !isGenerated(c);
  // A partition BIForge wrote is rebuilt from the source; one the user edited (no marker) is kept as is.
  const others = t.children.filter(
    (c) => c.kind !== "column" && !isGenerated(c) && !(c.kind === "annotation" && c.name === SOURCE_ANNOTATION),
  );
  const columns = info.columns.map((c) => columnNode(c.name, c.biType, newId, oldColumns.get(c.name.toLowerCase())));
  const ann = node("annotation", SOURCE_ANNOTATION);
  ann.default = { text: JSON.stringify(source), verbatim: false };
  const partitions = others.some(isOwnPartition) ? [] : [generatedPartition(info.name, source, info.columns)];
  t.children = [...columns, ...others, ...partitions, ann];
  const removedRelationships = removeRelationshipsOnColumns(p, info.name, gone);
  return { created, removedRelationships };
}

export function getTableSource(p: Project, table: string): SourceSpec | null {
  const t = findTable(p, table);
  const a = t?.node.children.find((c) => c.kind === "annotation" && c.name === SOURCE_ANNOTATION);
  if (!a?.default) return null;
  try {
    return JSON.parse(a.default.text) as SourceSpec;
  } catch {
    return null;
  }
}

export function columnDataType(p: Project, table: string, column: string): string | null {
  const c = findTable(p, table)?.node.children.find((x) => x.kind === "column" && x.name?.toLowerCase() === column.toLowerCase());
  return c ? textProp(c, "dataType") : null;
}

/** Tables that have an import source (those can be refreshed). */
export function importedTables(p: Project): string[] {
  return Object.values(p.model.tmdl)
    .flatMap((d) => d.nodes)
    .filter((n) => n.kind === "table" && n.name && getTableSource(p, n.name))
    .map((n) => n.name!);
}
