// Builds the Power Query (M) text of a table partition from an import source, so the project opens in
// Power BI Desktop and refreshes there from the same file/database. Pure text generation; no evaluation.
import type { ColumnInfo, SourceSpec } from "../data/types";

/** M string literal. */
export const mText = (s: string) => `"${s.replace(/"/g, '""').replace(/\r/g, "#(cr)").replace(/\n/g, "#(lf)").replace(/\t/g, "#(tab)")}"`;

/** M type expression for a loaded column. */
export function mType(c: ColumnInfo): string {
  const d = c.duckdbType.toUpperCase();
  if (d === "DATE") return "type date";
  if (d === "TIME") return "type time";
  if (d.startsWith("TIMESTAMP")) return "type datetime";
  switch (c.biType) {
    case "int64":
      return "Int64.Type";
    case "double":
      return "type number";
    case "decimal":
      return "Currency.Type";
    case "boolean":
      return "type logical";
    case "dateTime":
      return "type datetime";
    case "binary":
      return "type binary";
    default:
      return "type text";
  }
}

type Step = { name: string; expr: string };

function step(name: string, expr: string): Step {
  return { name, expr };
}

function typeStep(prev: string, columns: ColumnInfo[]) {
  const list = columns.map((c) => `{${mText(c.name)}, ${mType(c)}}`).join(", ");
  return step("#\"Changed Type\"", `Table.TransformColumnTypes(${prev}, {${list}}, "en-US")`);
}

const hasQuery = (q?: string | null) => !!q && q.trim() !== "";
const cleanQuery = (q: string) => q.trim().replace(/;+\s*$/, "");
/** The options record that carries custom SQL (a native query); nothing when there is none. */
const queryOption = (q?: string | null) => (hasQuery(q) ? `, [Query=${mText(cleanQuery(q!))}]` : "");

/** The path after Dbq= in an Access connection string. */
const dbqOf = (connection: string) => /(?:^|;)\s*Dbq=([^;]+)/i.exec(connection)?.[1]?.trim() ?? null;

/** "schema.table" to [schema, table]; a name without a dot has no schema. */
function splitName(t: string): [string, string] {
  const i = t.indexOf(".");
  return i < 0 ? ["", t] : [t.slice(0, i), t.slice(i + 1)];
}

/**
 * JSON records that were expanded on import ("address.city" came from the record column "address"): the Table.ExpandRecordColumn
 * steps that give Power Query the same columns. A name with a dot whose first part is not a column of its own counts as expanded.
 */
function expandSteps(columns: ColumnInfo[], steps: Step[]): void {
  const names = columns.map((c) => c.name);
  const have = new Set(names);
  // the columns of the table before any expansion: the first part of each dotted name that is not a column of its own
  let current = [...new Set(names.map((n) => (n.indexOf(".") > 0 && !have.has(n.slice(0, n.indexOf("."))) ? n.slice(0, n.indexOf(".")) : n)))];
  for (let guard = 0; guard < 30; guard++) {
    const todo = current.find((n) => !have.has(n) && names.some((x) => x.startsWith(`${n}.`)));
    if (!todo) return;
    const subs = [...new Set(names.filter((x) => x.startsWith(`${todo}.`)).map((x) => x.slice(todo.length + 1).split(".")[0]))];
    const prev = steps[steps.length - 1].name;
    steps.push(step(`#"Expanded ${todo.replace(/"/g, "")}"`, `Table.ExpandRecordColumn(${prev}, ${mText(todo)}, {${subs.map(mText).join(", ")}}, {${subs.map((x) => mText(`${todo}.${x}`)).join(", ")}})`));
    current = current.flatMap((n) => (n === todo ? subs.map((x) => `${todo}.${x}`) : [n]));
  }
}

function odbcSteps(source: Extract<SourceSpec, { kind: "odbc" }>, steps: Step[]): void {
  const [schema, item] = splitName(source.table ?? "");
  const q = hasQuery(source.query);
  const server = source.server ?? "";
  const generic = (): void => {
    steps.push(step("Source", `Odbc.Query(${mText(source.connection)}, ${mText(q ? cleanQuery(source.query!) : `SELECT * FROM ${source.table}`)})`));
  };
  const table = (fallbackSchema: string) => {
    if (!q) steps.push(step('#"Table"', `Source{[Schema=${mText(schema || fallbackSchema)}, Item=${mText(item)}]}[Data]`));
  };
  switch (source.flavor) {
    case "access": {
      const path = dbqOf(source.connection);
      if (!path || q) return generic();
      steps.push(step("Source", `Access.Database(File.Contents(${mText(path)}), [CreateNavigationProperties=true])`));
      steps.push(step('#"Table"', `Source{[Schema="", Item=${mText(source.table ?? "")}]}[Data]`));
      return;
    }
    case "oracle":
      if (!server) return generic();
      steps.push(step("Source", `Oracle.Database(${mText(server)}${queryOption(source.query)})`));
      return table("");
    case "db2":
      if (!server || !source.database) return generic();
      steps.push(step("Source", `DB2.Database(${mText(server)}, ${mText(source.database)}${queryOption(source.query)})`));
      return table("");
    case "teradata":
      if (!server) return generic();
      steps.push(step("Source", `Teradata.Database(${mText(server)}${queryOption(source.query)})`));
      return table("");
    case "redshift":
      if (!server || !source.database) return generic();
      steps.push(step("Source", `AmazonRedshift.Database(${mText(server)}, ${mText(source.database)}${queryOption(source.query)})`));
      return table("public");
    default:
      return generic();
  }
}

/** Web.Contents with the plain request headers; secret headers are not written into the query (their values live only in the credential store). */
function webContents(source: Extract<SourceSpec, { kind: "web" }>): string {
  const plain = (source.headers ?? []).filter((h) => !h.secret && h.name.trim() !== "");
  const opt = plain.length ? `, [Headers=[${plain.map((h) => `#${mText(h.name.trim())}=${mText(h.value ?? "")}`).join(", ")}]]` : "";
  return `Web.Contents(${mText(source.url)}${opt})`;
}

function webSteps(source: Extract<SourceSpec, { kind: "web" }>, columns: ColumnInfo[], steps: Step[]): void {
  const url = mText(source.url);
  const wc = webContents(source);
  const prev = () => steps[steps.length - 1].name;
  switch ((source.format ?? "auto").toLowerCase()) {
    case "json":
      steps.push(step("Source", `Json.Document(${wc})`));
      if (source.table) steps.push(step('#"Navigation"', `Source[${mText(source.table)}]`));
      steps.push(step('#"Converted to Table"', `Table.FromRecords(${prev()})`));
      expandSteps(columns, steps);
      steps.push(typeStep(prev(), columns));
      return;
    case "csv":
      steps.push(step("Source", `Csv.Document(${wc}, [Delimiter=",", Encoding=65001, QuoteStyle=QuoteStyle.Csv])`));
      steps.push(step('#"Promoted Headers"', `Table.PromoteHeaders(${prev()}, [PromoteAllScalars=true])`));
      steps.push(typeStep(prev(), columns));
      return;
    case "xml":
      steps.push(step("Source", `Xml.Tables(${wc})`));
      steps.push(step('#"Table"', source.table ? `Source{[Name=${mText(source.table)}]}[Table]` : "Source{0}[Table]"));
      steps.push(typeStep(prev(), columns));
      return;
    default: {
      // pages without captions name their tables "Table N" counting from 1; Power Query's own ids count from 0
      const m = /^Table (\d+)$/.exec(source.table ?? "");
      steps.push(step("Source", `Web.Page(${wc})`));
      steps.push(step('#"Table"', m ? `Source{[Id=${mText(`Table ${Number(m[1]) - 1}`)}]}[Data]` : source.table ? `Source{[Caption=${mText(source.table)}]}[Data]` : "Source{0}[Data]"));
      steps.push(typeStep(prev(), columns));
    }
  }
}

const INLINE_TYPE: Record<string, string> = { text: "text", whole: "Int64.Type", decimal: "number", logical: "logical", date: "date", datetime: "datetime" };

/** M literal of a typed-in cell. The values were validated by the engine on import; a cell that does not parse becomes null. */
function inlineValue(ty: string, v: string | null): string {
  if (v === null) return "null";
  const t = v.trim();
  if (ty === "text") return mText(v);
  if (t === "") return "null";
  switch (ty) {
    case "whole":
      return /^-?\d+$/.test(t) ? t : "null";
    case "decimal": {
      const n = t.replace(",", ".");
      return /^-?\d+(\.\d+)?$/.test(n) ? n : "null";
    }
    case "logical":
      return /^(true|yes|1)$/i.test(t) ? "true" : /^(false|no|0)$/i.test(t) ? "false" : "null";
    case "date": {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
      return m ? `#date(${Number(m[1])}, ${Number(m[2])}, ${Number(m[3])})` : "null";
    }
    default: {
      const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(t);
      return m ? `#datetime(${Number(m[1])}, ${Number(m[2])}, ${Number(m[3])}, ${Number(m[4])}, ${Number(m[5])}, ${Number(m[6] ?? 0)})` : "null";
    }
  }
}

/**
 * The M query for `source` that yields `columns`. Throws when the source cannot be expressed.
 * File formats whose M connector returns typed columns on its own (Parquet, databases) get no type step.
 */
export function partitionM(source: SourceSpec, columns: ColumnInfo[]): string {
  const steps: Step[] = [];
  const prev = () => steps[steps.length - 1].name;
  switch (source.kind) {
    case "csv": {
      const delim = source.delimiter && source.delimiter.length > 0 ? source.delimiter : ",";
      steps.push(
        step(
          "Source",
          `Csv.Document(File.Contents(${mText(source.path)}), [Delimiter=${mText(delim)}, Columns=${columns.length}, Encoding=65001, QuoteStyle=QuoteStyle.Csv])`,
        ),
      );
      if (source.header !== false) steps.push(step('#"Promoted Headers"', `Table.PromoteHeaders(${prev()}, [PromoteAllScalars=true])`));
      else
        steps.push(step('#"Renamed Columns"', `Table.RenameColumns(${prev()}, {${columns.map((c, i) => `{"Column${i + 1}", ${mText(c.name)}}`).join(", ")}})`));
      steps.push(typeStep(prev(), columns));
      break;
    }
    case "excel": {
      const hdr = source.header !== false;
      steps.push(step("Source", `Excel.Workbook(File.Contents(${mText(source.path)}), ${hdr}, true)`));
      steps.push(step('#"Sheet"', source.sheet ? `Source{[Item=${mText(source.sheet)}, Kind="Sheet"]}[Data]` : `Source{0}[Data]`));
      steps.push(typeStep(prev(), columns));
      break;
    }
    case "json":
      steps.push(step("Source", `Json.Document(File.Contents(${mText(source.path)}))`));
      steps.push(step('#"Converted to Table"', `Table.FromRecords(${prev()})`));
      expandSteps(columns, steps);
      steps.push(typeStep(prev(), columns));
      break;
    case "parquet":
      steps.push(step("Source", `Parquet.Document(File.Contents(${mText(source.path)}))`));
      break;
    case "sqlite":
      // Needs the SQLite ODBC driver installed on the machine that opens the project.
      steps.push(step("Source", `Odbc.Query(${mText(`Driver={SQLite3 ODBC Driver};Database=${source.path};`)}, ${mText(`SELECT * FROM "${source.table.replace(/"/g, '""')}"`)})`));
      break;
    case "postgres":
      steps.push(step("Source", `PostgreSQL.Database(${mText(`${source.host}:${source.port ?? 5432}`)}, ${mText(source.database)}${queryOption(source.query)})`));
      if (!hasQuery(source.query)) steps.push(step('#"Table"', `Source{[Schema=${mText(source.schema ?? "public")}, Item=${mText(source.table)}]}[Data]`));
      break;
    case "sqlserver":
      steps.push(step("Source", `Sql.Database(${mText(source.port ? `${source.server},${source.port}` : source.server)}, ${mText(source.database)}${queryOption(source.query)})`));
      if (!hasQuery(source.query)) steps.push(step('#"Table"', `Source{[Schema=${mText(source.schema ?? "dbo")}, Item=${mText(source.table)}]}[Data]`));
      break;
    case "mysql":
      steps.push(step("Source", `MySQL.Database(${mText(`${source.host}:${source.port ?? 3306}`)}, ${mText(source.database)}${queryOption(source.query)})`));
      if (!hasQuery(source.query)) steps.push(step('#"Table"', `Source{[Schema=${mText(source.database)}, Item=${mText(source.table)}]}[Data]`));
      break;
    case "odbc":
      odbcSteps(source, steps);
      break;
    case "oledb":
      steps.push(step("Source", `OleDb.Query(${mText(source.connection)}, ${mText(hasQuery(source.query) ? cleanQuery(source.query!) : `SELECT * FROM ${source.table}`)})`));
      break;
    case "analysisServices":
      steps.push(step("Source", `AnalysisServices.Database(${mText(source.server)}, ${mText(source.database)}, [Query=${mText(hasQuery(source.query) ? cleanQuery(source.query!) : `EVALUATE '${(source.table ?? "").replace(/'/g, "''")}'`)}])`));
      break;
    case "script":
      steps.push(step("Source", `${source.language === "r" ? "R" : "Python"}.Execute(${mText(source.code)})`));
      steps.push(step('#"Table"', source.table ? `Source{[Name=${mText(source.table)}]}[Value]` : "Source{0}[Value]"));
      break;
    case "xml":
      steps.push(step("Source", `Xml.Tables(File.Contents(${mText(source.path)}))`));
      steps.push(step('#"Table"', source.table ? `Source{[Name=${mText(source.table)}]}[Table]` : "Source{0}[Table]"));
      steps.push(typeStep(prev(), columns));
      break;
    case "pdf": {
      steps.push(step("Source", `Pdf.Tables(File.Contents(${mText(source.path)}), [Implementation="1.3"])`));
      const id = source.table ? source.table.split(" ")[0] : null; // "Table001 (Page 1)" -> the Id Power Query uses
      steps.push(step('#"Table"', id ? `Source{[Id=${mText(id)}]}[Data]` : "Source{0}[Data]"));
      steps.push(typeStep(prev(), columns));
      break;
    }
    case "fixedWidth": {
      const starts: number[] = [];
      let at = 0;
      for (const w of source.widths) {
        starts.push(at);
        at += w;
      }
      const names = source.widths.map((_, i) => `Column${i + 1}`);
      steps.push(step("Source", `Lines.FromBinary(File.Contents(${mText(source.path)}), null, null, 65001)`));
      steps.push(step('#"Lines"', `Table.FromList(${prev()}, Splitter.SplitByNothing(), {"Line"})`));
      steps.push(step('#"Split"', `Table.SplitColumn(${prev()}, "Line", Splitter.SplitTextByPositions({${starts.join(", ")}}), {${names.map(mText).join(", ")}})`));
      steps.push(step('#"Trimmed"', `Table.TransformColumns(${prev()}, {${names.map((n) => `{${mText(n)}, Text.Trim, type text}`).join(", ")}})`));
      if (source.header !== false) steps.push(step('#"Promoted Headers"', `Table.PromoteHeaders(${prev()}, [PromoteAllScalars=true])`));
      steps.push(typeStep(prev(), columns));
      break;
    }
    case "web":
      webSteps(source, columns, steps);
      break;
    case "inline": {
      const type = source.columns.map((c) => `#${mText(c.name)} = ${INLINE_TYPE[c.type] ?? "text"}`).join(", ");
      const rows = source.rows.map((r) => `{${source.columns.map((c, i) => inlineValue(c.type, r[i] ?? null)).join(", ")}}`).join(", ");
      steps.push(step("Source", `#table(type table [${type}], {${rows}})`));
      break;
    }
    case "odata":
      steps.push(step("Source", `OData.Feed(${mText(source.url)}, null, [Implementation="2.0"])`));
      steps.push(step('#"Table"', `Source{[Name=${mText(source.entity)}]}[Data]`));
      break;
  }
  const body = steps.map((s, i) => `\t${s.name} = ${s.expr}${i < steps.length - 1 ? "," : ""}`).join("\n");
  const last = steps[steps.length - 1].name;
  return `let\n${body}\nin\n\t${last}`;
}
