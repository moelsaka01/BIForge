// Paginated report definitions (.rdl): the subset BIForge draws. The first Tablix of the body (a table with a header row and a
// detail row) over one dataset, the page size and margins, and the report parameters. Grouping, subreports, charts, images and
// expressions other than =Fields!Name.Value are not drawn; `RdlReport.notes` lists what was left out.

export interface RdlColumn {
  /** Header text of the column. */
  header: string;
  /** Name of the dataset field the detail cell shows (=Fields!Name.Value), or null for a fixed text. */
  field: string | null;
  /** The detail cell's text when it is not a field. */
  text: string;
  /** Width in millimetres. */
  width: number;
}

export interface RdlParameter {
  name: string;
  prompt: string;
  dataType: string;
  multiValue: boolean;
  /** The default values written in the report. */
  defaults: string[];
  /** The valid values (value, label), when the report lists them. */
  options: { value: string; label: string }[];
}

export interface RdlDataSet {
  name: string;
  /** Field name -> the name the data source gives it. */
  fields: { name: string; dataField: string }[];
  commandText: string;
}

export interface RdlPage {
  /** Millimetres. */
  width: number;
  height: number;
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
}

export interface RdlReport {
  page: RdlPage;
  parameters: RdlParameter[];
  dataSets: RdlDataSet[];
  table: { name: string; dataSet: string; columns: RdlColumn[]; headerHeight: number; rowHeight: number } | null;
  /** The text of the first text box above the table, if any (the report's title). */
  title: string;
  /** What the definition holds that is not drawn. */
  notes: string[];
}

const MM: Record<string, number> = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6 };

/** "21cm", "8.5in", "10pt" -> millimetres; null when the text is not a length. */
export function lengthMm(text: string | null | undefined): number | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(mm|cm|in|pt|pc)\s*$/i.exec(text ?? "");
  return m ? Number(m[1]) * MM[m[2].toLowerCase()] : null;
}

const kids = (el: Element, name: string): Element[] => Array.from(el.children).filter((c) => c.localName === name);
const kid = (el: Element | null | undefined, name: string): Element | null => (el ? (kids(el, name)[0] ?? null) : null);
const below = (el: Element | null | undefined, name: string): Element[] => (el ? Array.from(el.getElementsByTagName("*")).filter((c) => c.localName === name) : []);
const textOf = (el: Element | null | undefined): string => (el?.textContent ?? "").trim();

/** The fixed text or the field of a cell: its text box's first text run. */
function cellValue(cell: Element): { text: string; field: string | null; expression: boolean } {
  const run = below(cell, "TextRun")[0];
  const raw = textOf(kid(run, "Value") ?? below(cell, "Value")[0]);
  const field = /^=\s*Fields!([A-Za-z_][\w]*)\.Value\s*$/.exec(raw);
  if (field) return { text: "", field: field[1], expression: false };
  return { text: raw.startsWith("=") ? "" : raw, field: null, expression: raw.startsWith("=") };
}

/** Parses a report definition. Throws an Error with a plain message when the text is not one. */
export function parseRdl(xml: string): RdlReport {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) throw new Error("The file is not well-formed XML.");
  const root = doc.documentElement;
  if (!root || root.localName !== "Report") throw new Error("The file is not a report definition: its root element is not Report.");
  const notes: string[] = [];

  // page: Report/ReportSections/ReportSection/Page (2016) or Report/PageHeight... (2008)
  const section = below(root, "ReportSection")[0] ?? null;
  const pageEl = kid(section, "Page") ?? root;
  const len = (name: string, fallback: number) => lengthMm(textOf(kid(pageEl, name))) ?? lengthMm(textOf(kid(root, name))) ?? fallback;
  const page: RdlPage = { width: len("PageWidth", 215.9), height: len("PageHeight", 279.4), marginTop: len("TopMargin", 0), marginBottom: len("BottomMargin", 0), marginLeft: len("LeftMargin", 0), marginRight: len("RightMargin", 0) };

  // data sets
  const dataSets: RdlDataSet[] = below(root, "DataSet").map((d) => ({
    name: d.getAttribute("Name") ?? "",
    fields: below(kid(d, "Fields"), "Field").map((f) => ({ name: f.getAttribute("Name") ?? "", dataField: textOf(kid(f, "DataField")) || (f.getAttribute("Name") ?? "") })),
    commandText: textOf(kid(kid(d, "Query"), "CommandText")),
  }));

  // parameters
  const parameters: RdlParameter[] = below(kid(root, "ReportParameters"), "ReportParameter").map((p) => ({
    name: p.getAttribute("Name") ?? "",
    prompt: textOf(kid(p, "Prompt")) || (p.getAttribute("Name") ?? ""),
    dataType: textOf(kid(p, "DataType")) || "String",
    multiValue: textOf(kid(p, "MultiValue")).toLowerCase() === "true",
    defaults: below(kid(kid(p, "DefaultValue"), "Values"), "Value").map(textOf),
    options: below(kid(kid(p, "ValidValues"), "ParameterValues"), "ParameterValue").map((v) => ({ value: textOf(kid(v, "Value")), label: textOf(kid(v, "Label")) || textOf(kid(v, "Value")) })),
  }));

  // the first table in the body, and the text boxes above it
  const body = below(root, "Body")[0] ?? null;
  const items = kid(body, "ReportItems");
  const tablixes = below(items, "Tablix");
  if (tablixes.length > 1) notes.push(`${tablixes.length - 1} more table(s) in the report are not drawn.`);
  for (const other of ["Chart", "Subreport", "Image", "GaugePanel", "Map"]) if (below(items, other).length > 0) notes.push(`${other} items are not drawn.`);
  let table: RdlReport["table"] = null;
  const tx = tablixes[0];
  if (tx) {
    const tbody = kid(tx, "TablixBody");
    const cols = below(kid(tbody, "TablixColumns"), "TablixColumn").map((c) => lengthMm(textOf(kid(c, "Width"))) ?? 30);
    const rows = below(kid(tbody, "TablixRows"), "TablixRow");
    const cellsOf = (r: Element) => below(kid(r, "TablixCells"), "TablixCell");
    const head = rows.length > 1 ? cellsOf(rows[0]) : [];
    const detail = rows.length > 0 ? cellsOf(rows[rows.length - 1]) : [];
    if (rows.length > 2) notes.push("Group rows of the table are not drawn: only its header row and last row are.");
    const columns: RdlColumn[] = cols.map((width, i) => {
      const d = detail[i] ? cellValue(detail[i]) : { text: "", field: null, expression: false };
      if (d.expression) notes.push(`Column ${i + 1}: an expression other than =Fields!Name.Value is not evaluated.`);
      const h = head[i] ? cellValue(head[i]) : { text: d.field ?? "", field: null, expression: false };
      return { header: h.text || h.field || d.field || "", field: d.field, text: d.text, width };
    });
    table = {
      name: tx.getAttribute("Name") ?? "Tablix",
      dataSet: textOf(kid(tx, "DataSetName")) || dataSets[0]?.name || "",
      columns,
      headerHeight: rows.length > 1 ? (lengthMm(textOf(kid(rows[0], "Height"))) ?? 6) : 0,
      rowHeight: rows.length > 0 ? (lengthMm(textOf(kid(rows[rows.length - 1], "Height"))) ?? 6) : 6,
    };
  } else notes.push("The report has no table: nothing to draw.");

  // title: the first text box that is not inside the table
  let title = "";
  for (const tb of below(items, "Textbox")) {
    if (tx && tx.contains(tb)) continue;
    const v = cellValue(tb);
    if (v.text) {
      title = v.text;
      break;
    }
  }
  return { page, parameters, dataSets, table, title, notes };
}
