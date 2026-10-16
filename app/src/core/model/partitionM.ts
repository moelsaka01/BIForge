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

function step(name: string, expr: string): { name: string; expr: string } {
  return { name, expr };
}

function typeStep(prev: string, columns: ColumnInfo[]) {
  const list = columns.map((c) => `{${mText(c.name)}, ${mType(c)}}`).join(", ");
  return step("#\"Changed Type\"", `Table.TransformColumnTypes(${prev}, {${list}}, "en-US")`);
}

/**
 * The M query for `source` that yields `columns`. Throws when the source cannot be expressed.
 * File formats whose M connector returns typed columns on its own (Parquet, databases) get no type step.
 */
export function partitionM(source: SourceSpec, columns: ColumnInfo[]): string {
  const steps: { name: string; expr: string }[] = [];
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
      if (source.header !== false) steps.push(step("#\"Promoted Headers\"", `Table.PromoteHeaders(${prev()}, [PromoteAllScalars=true])`));
      else
        steps.push(step("#\"Renamed Columns\"", `Table.RenameColumns(${prev()}, {${columns.map((c, i) => `{"Column${i + 1}", ${mText(c.name)}}`).join(", ")}})`));
      steps.push(typeStep(prev(), columns));
      break;
    }
    case "excel": {
      const hdr = source.header !== false;
      steps.push(step("Source", `Excel.Workbook(File.Contents(${mText(source.path)}), ${hdr}, true)`));
      steps.push(
        step(
          "#\"Sheet\"",
          source.sheet ? `Source{[Item=${mText(source.sheet)}, Kind="Sheet"]}[Data]` : `Source{0}[Data]`,
        ),
      );
      steps.push(typeStep(prev(), columns));
      break;
    }
    case "json":
      steps.push(step("Source", `Json.Document(File.Contents(${mText(source.path)}))`));
      steps.push(step("#\"Converted to Table\"", `Table.FromRecords(${prev()})`));
      steps.push(typeStep(prev(), columns));
      break;
    case "parquet":
      steps.push(step("Source", `Parquet.Document(File.Contents(${mText(source.path)}))`));
      break;
    case "sqlite":
      // Needs the SQLite ODBC driver installed on the machine that opens the project.
      steps.push(
        step(
          "Source",
          `Odbc.Query(${mText(`Driver={SQLite3 ODBC Driver};Database=${source.path};`)}, ${mText(`SELECT * FROM "${source.table.replace(/"/g, '""')}"`)})`,
        ),
      );
      break;
    case "postgres":
      steps.push(step("Source", `PostgreSQL.Database(${mText(`${source.host}:${source.port ?? 5432}`)}, ${mText(source.database)})`));
      steps.push(step("#\"Table\"", `Source{[Schema=${mText(source.schema ?? "public")}, Item=${mText(source.table)}]}[Data]`));
      break;
  }
  const body = steps.map((s, i) => `\t${s.name} = ${s.expr}${i < steps.length - 1 ? "," : ""}`).join("\n");
  const last = steps[steps.length - 1].name;
  return `let\n${body}\nin\n\t${last}`;
}
