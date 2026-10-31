// The Paginated report visual: a report definition (.rdl) drawn as pages over the tables of the model. No report server is
// involved: the first table of the definition is read from the model (rdl.ts says which part of an .rdl is understood).
// Pure functions: the format (toolbar, export, auto filter, parameter mapping), the mapping of the dataset fields to the model,
// the pages, and the export texts.
import { fieldKey, lit, type FieldRef } from "./fields";
import type { FilterDef } from "./filters";
import { FormatReader } from "./formatReader";
import type { ModelInfo } from "./modelInfo";
import { parseVisual, projectionJson, type VisualModel } from "./visualDoc";
import type { RdlColumn, RdlParameter, RdlReport } from "./rdl";
import type { Theme } from "./theme";

export type ExportId = "CSV" | "XML" | "MHTML" | "PDF";

/** The export formats BIForge writes; the others of the Export card (Excel, Word, PowerPoint, accessible PDF) are not written yet. */
export const EXPORT_FORMATS: { id: ExportId; prop: string; label: string; ext: string; mime: string }[] = [
  { id: "CSV", prop: "exportCSV", label: "CSV (comma delimited)", ext: "csv", mime: "text/csv" },
  { id: "XML", prop: "exportXML", label: "XML", ext: "xml", mime: "application/xml" },
  { id: "MHTML", prop: "exportMHTML", label: "MHTML (web archive)", ext: "mhtml", mime: "message/rfc822" },
  { id: "PDF", prop: "exportPDF", label: "PDF (print)", ext: "pdf", mime: "application/pdf" },
];
export const EXPORTS_NOT_WRITTEN = ["Excel", "Word", "PowerPoint", "Accessible PDF"];

export interface PaginatedLook {
  toolbar: { show: boolean; position: "Top" | "Bottom"; floating: boolean; pageNavigation: boolean; parameters: boolean };
  exportShown: boolean;
  exports: typeof EXPORT_FORMATS;
  autoFilter: boolean;
  /** The report definition stored with the visual, and the name of the file it came from. */
  source: { xml: string; name: string };
  /** Report parameter name -> model column (the `parameterMapping.mappings` JSON: {"Category":"Product[Category]"}). */
  mappings: Record<string, string>;
  /** Why the mapping text maps nothing (it is not a JSON object of strings); empty when it is fine or empty. */
  mappingError: string;
}

/** Reads the format of a Paginated report visual. */
export function paginatedLook(visual: VisualModel, theme: Theme): PaginatedLook {
  const f = new FormatReader(visual.json, theme, visual.visualType);
  let mappings: Record<string, string> = {};
  let mappingError = "";
  const text = f.str("parameterMapping", "mappings", "").trim();
  if (text) {
    try {
      const m = JSON.parse(text);
      if (m && typeof m === "object" && !Array.isArray(m)) mappings = Object.fromEntries(Object.entries(m).filter(([, v]) => typeof v === "string")) as Record<string, string>;
      else mappingError = 'The parameter mapping must be a JSON object such as {"Category":"Product[Category]"}.';
    } catch {
      mappingError = 'The parameter mapping is not valid JSON; write it as {"Category":"Product[Category]"}.';
    }
  }
  return {
    toolbar: {
      show: f.bool("toolbar", "show", true),
      position: f.num("toolbar", "position", 0) === 1 ? "Bottom" : "Top",
      floating: f.bool("toolbar", "useFloatingToolbar", false),
      pageNavigation: f.bool("toolbar", "pageNavigation", true),
      parameters: f.bool("toolbar", "paramButton", true),
    },
    exportShown: f.bool("export", "show", true),
    exports: EXPORT_FORMATS.filter((x) => f.bool("export", x.prop, true)),
    autoFilter: f.bool("autoFilter", "show", true),
    source: { xml: f.str("reportInfo", "rdl", ""), name: f.str("reportInfo", "rdlName", "") },
    mappings,
    mappingError,
  };
}

// ---- the dataset fields -> model columns ---------------------------------------------------------------------

/** "Table[Column]", "'Table name'[Column]", "Table.Column" or a plain column name -> a model column; null when none (or several) match. */
export function resolveField(text: string, model: ModelInfo): FieldRef | null {
  const t = text.trim();
  const br = /^'?([^'[\]]+?)'?\[([^\]]+)\]$/.exec(t) ?? /^'?([^'.]+?)'?\.([^.]+)$/.exec(t);
  const known = (table: string, name: string): FieldRef | null => {
    const tbl = model.tables().find((x) => x.toLowerCase() === table.toLowerCase());
    if (!tbl) return null;
    const col = model.columns(tbl).find((x) => x.toLowerCase() === name.toLowerCase());
    if (col) return { kind: "column", table: tbl, name: col };
    const mea = model.measures(tbl).find((x) => x.toLowerCase() === name.toLowerCase());
    return mea ? { kind: "measure", table: tbl, name: mea } : null;
  };
  if (br) {
    const r = known(br[1], br[2]);
    if (r) return r;
  }
  const hits: FieldRef[] = [];
  for (const tbl of model.tables()) {
    const r = known(tbl, t);
    if (r) hits.push(r);
  }
  return hits.length === 1 ? hits[0] : null;
}

export interface MappedTable {
  /** One entry per column of the report's table. */
  columns: (RdlColumn & { ref: FieldRef | null; problem: string })[];
  /** The distinct model fields to read, in column order. */
  fields: FieldRef[];
  problems: string[];
}

/** Maps the columns of the report's table to model fields. */
export function mapTable(rdl: RdlReport, model: ModelInfo): MappedTable | null {
  if (!rdl.table) return null;
  const ds = rdl.dataSets.find((d) => d.name === rdl.table!.dataSet) ?? rdl.dataSets[0];
  const problems: string[] = [];
  const columns = rdl.table.columns.map((c) => {
    if (!c.field) return { ...c, ref: null, problem: "" };
    const dataField = ds?.fields.find((x) => x.name === c.field)?.dataField ?? c.field;
    const ref = resolveField(dataField, model);
    const problem = ref ? "" : `"${dataField}" is not a column or measure of the model.`;
    if (problem) problems.push(`${c.header || c.field}: ${problem}`);
    return { ...c, ref, problem };
  });
  const seen = new Set<string>();
  const fields: FieldRef[] = [];
  for (const c of columns) if (c.ref && !seen.has(fieldKey(c.ref))) (seen.add(fieldKey(c.ref)), fields.push(c.ref));
  return { columns, fields, problems };
}

/** The table visual (in memory only) whose query reads the fields of the report's table. */
export function queryVisual(pageName: string, name: string, fields: FieldRef[]): VisualModel | null {
  if (fields.length === 0) return null;
  return parseVisual(pageName, {
    name,
    position: { x: 0, y: 0, z: 0, width: 400, height: 300 },
    visual: { visualType: "tableEx", query: { queryState: { Values: { projections: fields.map((field) => projectionJson({ field })) } } } },
  });
}

// ---- parameters -------------------------------------------------------------------------------------------------

/** The model column a report parameter filters: the mapping of the format, or the column of the dataset field with the same name. */
export function parameterColumn(p: RdlParameter, look: PaginatedLook, mapped: MappedTable | null, model: ModelInfo): FieldRef | null {
  const m = look.mappings[p.name];
  if (m) {
    const r = resolveField(m, model);
    return r && r.kind === "column" ? r : null;
  }
  const c = mapped?.columns.find((x) => x.field?.toLowerCase() === p.name.toLowerCase() && x.ref?.kind === "column");
  return c?.ref ?? null;
}

/** The filters the chosen parameter values put on the data (an empty choice filters nothing). */
export function parameterFilters(rdl: RdlReport, look: PaginatedLook, mapped: MappedTable | null, values: Record<string, string[]>, model: ModelInfo): FilterDef[] {
  const out: FilterDef[] = [];
  for (const p of rdl.parameters) {
    const chosen = (values[p.name] ?? []).filter((x) => x !== "");
    const col = parameterColumn(p, look, mapped, model);
    if (!col || chosen.length === 0) continue;
    out.push({ name: `rdl-param-${p.name}`, field: col, cond: { kind: "in", values: chosen.map((v) => lit.str(v)) } });
  }
  return out;
}

/** The values a parameter starts with: what the report says, or nothing. */
export const defaultValues = (rdl: RdlReport): Record<string, string[]> => Object.fromEntries(rdl.parameters.map((p) => [p.name, p.defaults]));

// ---- pages ------------------------------------------------------------------------------------------------------

/** How many rows fit on a page of the report (at least one). */
export function rowsPerPage(rdl: RdlReport): number {
  if (!rdl.table) return 1;
  const { page, table } = rdl;
  const usable = page.height - page.marginTop - page.marginBottom - table.headerHeight - (rdl.title ? 12 : 0);
  return Math.max(1, Math.floor(usable / Math.max(1, table.rowHeight)));
}

/** The rows split into pages (one empty page when there are no rows). */
export function paginate<T>(rows: T[], perPage: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += perPage) out.push(rows.slice(i, i + perPage));
  return out.length ? out : [[]];
}

// ---- export texts -----------------------------------------------------------------------------------------------

export interface TableText {
  title: string;
  headers: string[];
  rows: string[][];
}

const csvCell = (t: string) => (/[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);
export const tableCsv = (t: TableText): string => [t.headers, ...t.rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tag = (h: string, i: number) => h.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^(\d)/, "_$1") || `Column${i + 1}`;

/** The data as XML: a Report element with one Row per row and one element per column. */
export function tableXml(t: TableText): string {
  const names = t.headers.map(tag);
  const rows = t.rows.map((r) => `  <Row>${r.map((c, i) => `<${names[i]}>${esc(c)}</${names[i]}>`).join("")}</Row>`);
  return `<?xml version="1.0" encoding="utf-8"?>\n<Report Name="${esc(t.title)}">\n${rows.join("\n")}\n</Report>\n`;
}

/** The pages as one HTML document (the page break after each page); used by the print and the web archive. */
export function pagesHtml(t: TableText, rdl: RdlReport, perPage: number): string {
  const widths = rdl.table?.columns.map((c) => c.width) ?? [];
  const pages = paginate(t.rows, perPage);
  const head = `<tr>${t.headers.map((h, i) => `<th style="width:${widths[i] ?? 30}mm;text-align:left;border-bottom:1px solid #444">${esc(h)}</th>`).join("")}</tr>`;
  const body = pages.map((rows, pi) => `<section style="page-break-after:${pi === pages.length - 1 ? "auto" : "always"}">${t.title ? `<h1 style="font-size:14pt">${esc(t.title)}</h1>` : ""}<table style="border-collapse:collapse;font:9pt Segoe UI,Arial,sans-serif">${head}${rows.map((r) => `<tr>${r.map((c) => `<td style="padding:1mm 2mm 1mm 0">${esc(c)}</td>`).join("")}</tr>`).join("")}</table><p style="font:8pt Segoe UI,Arial,sans-serif;color:#555">Page ${pi + 1} of ${pages.length}</p></section>`).join("");
  const { page } = rdl;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(t.title || "Report")}</title><style>@page{size:${page.width}mm ${page.height}mm;margin:${page.marginTop}mm ${page.marginRight}mm ${page.marginBottom}mm ${page.marginLeft}mm}body{margin:0}</style></head><body>${body}</body></html>`;
}

/** A web archive (MHTML): the pages' HTML as the single part of a MIME message (base64 body). */
export function mhtml(html: string, title: string): string {
  const bytes = new TextEncoder().encode(html);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin).replace(/(.{76})/g, "$1\r\n");
  return ["MIME-Version: 1.0", `Subject: ${title.replace(/[\r\n]+/g, " ")}`, 'Content-Type: multipart/related; boundary="----=_biforge_part"; type="text/html"', "", "------=_biforge_part", 'Content-Type: text/html; charset="utf-8"', "Content-Transfer-Encoding: base64", "", b64, "", "------=_biforge_part--", ""].join("\r\n");
}
