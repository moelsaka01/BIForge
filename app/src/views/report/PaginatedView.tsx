import { useEffect, useMemo, useState } from "react";
import { labelOf } from "../../core/report/chartData";
import { exportFileName } from "../../core/report/exportData";
import { defaultValues, EXPORTS_NOT_WRITTEN, mapTable, mhtml, pagesHtml, paginate, paginatedLook, parameterColumn, parameterFilters, queryVisual, rowsPerPage, tableCsv, tableXml, type ExportId, type TableText } from "../../core/report/paginated";
import { parseRdl, type RdlReport } from "../../core/report/rdl";
import type { PageModel, VisualModel } from "../../core/report/visualDoc";
import { browserFiles } from "../shell/files";
import { useReport } from "./reportContext";

/** Prints an HTML document through a hidden frame (the browser's print dialog also saves a PDF). */
export function printHtml(html: string): void {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  frame.srcdoc = html;
  frame.onload = () => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    setTimeout(() => frame.remove(), 60000);
  };
  document.body.appendChild(frame);
}

const btn = { fontSize: 12, padding: "2px 8px", border: "1px solid #c8c6c4", borderRadius: 3, background: "#fff", color: "#201f1e", cursor: "pointer" } as const;

/** Paginated report: the report definition stored with the visual, drawn as pages over the model, with a toolbar for the pages, the parameters and the export. */
export function PaginatedView({ page, visual, width, height }: { page: PageModel; visual: VisualModel; width: number; height: number }) {
  const c = useReport();
  const look = useMemo(() => paginatedLook(visual, c.theme), [visual, c.theme]);
  const parsed = useMemo((): { rdl: RdlReport | null; error: string } => {
    if (!look.source.xml.trim()) return { rdl: null, error: "" };
    try {
      return { rdl: parseRdl(look.source.xml), error: "" };
    } catch (e) {
      return { rdl: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [look.source.xml]);
  const rdl = parsed.rdl;
  const mapped = useMemo(() => (rdl ? mapTable(rdl, c.model) : null), [rdl, c.model]);
  const [values, setValues] = useState<Record<string, string[]>>({});
  const [pageNo, setPageNo] = useState(0);
  const [paramsOpen, setParamsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [note, setNote] = useState("");
  const [data, setData] = useState<{ rows: string[][]; error: string } | null>(null);
  // the parameters start with the defaults of the report
  useEffect(() => {
    setValues(rdl ? defaultValues(rdl) : {});
    setPageNo(0);
  }, [rdl]);
  const filters = useMemo(() => (rdl ? parameterFilters(rdl, look, mapped, values, c.model) : []), [rdl, look, mapped, values, c.model]);
  const filterKey = JSON.stringify(filters);
  useEffect(() => {
    if (!rdl || !mapped || mapped.fields.length === 0) {
      setData(null);
      return;
    }
    let off = false;
    const qv = queryVisual(page.name, `${visual.name}__rdl`, mapped.fields);
    if (!qv) return;
    void c.data
      .rows(c.project, page, visual, c.view, c.model, qv, filters, !look.autoFilter)
      .then((r) => {
        if (off || !r) return;
        const cols = r.query.columns.filter((x) => x.kind !== "helper").sort((a, b) => a.index - b.index);
        const rows = r.rows.map((row) =>
          mapped.columns.map((col) => {
            if (!col.ref) return col.text;
            const i = mapped.fields.findIndex((f) => f.kind === col.ref!.kind && f.table === col.ref!.table && f.name === col.ref!.name);
            const qc = cols[i];
            return qc ? labelOf(row[qc.index], qc.format) : "";
          }),
        );
        setData({ rows, error: "" });
        setPageNo(0);
      })
      .catch((e) => !off && setData({ rows: [], error: e instanceof Error ? e.message : String(e) }));
    return () => {
      off = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rdl, mapped, filterKey, look.autoFilter, c.project, c.view, c.model]);

  if (!rdl) {
    return (
      <div role={parsed.error ? "alert" : "status"} data-testid="paginated-empty" style={{ height: "100%", boxSizing: "border-box", padding: 12, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", fontSize: 12, color: parsed.error ? "#c50f1f" : "inherit" }}>
        {parsed.error ? `Cannot read the report definition: ${parsed.error}` : "Choose a report definition: Insert > Paginated report."}
      </div>
    );
  }
  const table = rdl.table;
  const perPage = rowsPerPage(rdl);
  const pages = paginate(data?.rows ?? [], perPage);
  const no = Math.min(pageNo, pages.length - 1);
  const text: TableText = { title: rdl.title || look.source.name.replace(/\.rdl$/i, "") || "Report", headers: table?.columns.map((x) => x.header) ?? [], rows: data?.rows ?? [] };

  const doExport = (id: ExportId) => {
    setExportOpen(false);
    const base = exportFileName(text.title, "x").replace(/\.x$/, "");
    if (id === "CSV") browserFiles.save(`${base}.csv`, tableCsv(text), "text/csv");
    else if (id === "XML") browserFiles.save(`${base}.xml`, tableXml(text), "application/xml");
    else if (id === "MHTML") browserFiles.save(`${base}.mhtml`, mhtml(pagesHtml(text, rdl, perPage), text.title), "message/rfc822");
    else printHtml(pagesHtml(text, rdl, perPage));
    setNote(`Exported ${id}`);
    setTimeout(() => setNote(""), 3000);
  };

  const tb = look.toolbar;
  const toolbar = tb.show && (
    <div
      role="toolbar"
      aria-label="Report toolbar"
      data-testid="paginated-toolbar"
      data-floating={tb.floating ? "true" : undefined}
      style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 6px", fontSize: 12, background: tb.floating ? "rgba(255,255,255,0.94)" : "#f3f2f1", borderBottom: tb.position === "Top" && !tb.floating ? "1px solid #e1dfdd" : undefined, borderTop: tb.position === "Bottom" && !tb.floating ? "1px solid #e1dfdd" : undefined, ...(tb.floating ? { position: "absolute", left: 8, right: 8, [tb.position === "Top" ? "top" : "bottom"]: 6, borderRadius: 4, boxShadow: "0 2px 8px rgba(0,0,0,0.25)", zIndex: 2 } : { flex: "none" }) }}
    >
      {tb.pageNavigation && (
        <>
          <button type="button" style={btn} aria-label="Previous page" disabled={no <= 0} onClick={() => setPageNo(no - 1)}>
            ◀
          </button>
          <span data-testid="paginated-page-number" aria-live="polite">
            Page {no + 1} of {pages.length}
          </span>
          <button type="button" style={btn} aria-label="Next page" disabled={no >= pages.length - 1} onClick={() => setPageNo(no + 1)}>
            ▶
          </button>
        </>
      )}
      {tb.parameters && rdl.parameters.length > 0 && (
        <button type="button" style={btn} aria-pressed={paramsOpen} onClick={() => setParamsOpen(!paramsOpen)}>
          Parameters
        </button>
      )}
      <span style={{ flex: 1 }} />
      {note && <span role="status">{note}</span>}
      {look.exportShown && (
        <span style={{ position: "relative" }}>
          <button type="button" style={btn} aria-haspopup="menu" aria-expanded={exportOpen} onClick={() => setExportOpen(!exportOpen)}>
            Export
          </button>
          {exportOpen && (
            <div role="menu" data-testid="paginated-export-menu" style={{ position: "absolute", right: 0, [tb.position === "Bottom" ? "bottom" : "top"]: 26, background: "#fff", border: "1px solid #c8c6c4", borderRadius: 3, boxShadow: "0 2px 8px rgba(0,0,0,0.2)", zIndex: 3, minWidth: 190, padding: 2, color: "#201f1e" }}>
              {look.exports.map((x) => (
                <button key={x.id} type="button" role="menuitem" style={{ ...btn, display: "block", width: "100%", textAlign: "left", border: "none" }} onClick={() => doExport(x.id)}>
                  {x.label}
                </button>
              ))}
              {look.exports.length === 0 && <div style={{ padding: "4px 8px", color: "#605e5c" }}>No export format is turned on.</div>}
              <div style={{ padding: "4px 8px", fontSize: 10, color: "#605e5c", borderTop: "1px solid #e1dfdd" }}>Not available yet: {EXPORTS_NOT_WRITTEN.join(", ")}.</div>
            </div>
          )}
        </span>
      )}
    </div>
  );

  const paramPane = paramsOpen && rdl.parameters.length > 0 && (
    <div data-testid="paginated-parameters" style={{ flex: "none", padding: "4px 8px", fontSize: 12, background: "#faf9f8", borderBottom: "1px solid #e1dfdd", display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
      {rdl.parameters.map((p) => {
        const col = parameterColumn(p, look, mapped, c.model);
        const cur = values[p.name] ?? [];
        const set = (v: string[]) => setValues({ ...values, [p.name]: v });
        return (
          <label key={p.name} style={{ display: "flex", gap: 4, alignItems: "center" }}>
            {p.prompt}
            {p.options.length > 0 ? (
              <select aria-label={p.prompt} multiple={p.multiValue} value={p.multiValue ? cur : (cur[0] ?? "")} onChange={(e) => set(p.multiValue ? Array.from(e.target.selectedOptions).map((o) => o.value) : e.target.value ? [e.target.value] : [])}>
                {!p.multiValue && <option value="">(all)</option>}
                {p.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input aria-label={p.prompt} value={cur[0] ?? ""} onChange={(e) => set(e.target.value ? [e.target.value] : [])} style={{ width: 110 }} />
            )}
            {!col && (
              <span title="Map this parameter to a column in Format > Parameter mapping" style={{ color: "#a4262c" }}>
                (not mapped)
              </span>
            )}
          </label>
        );
      })}
    </div>
  );

  const k = Math.min(4, Math.max(0.5, (width - 24) / rdl.page.width)); // pixels per millimetre: the page is as wide as the visual
  const cell = { padding: `0 ${1.2 * k}px`, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as const;
  const problems = [...(look.mappingError ? [look.mappingError] : []), ...(mapped?.problems ?? []), ...rdl.notes];
  const sheet = (
    <div style={{ flex: 1, minHeight: 0, overflow: "auto", background: "#e1dfdd", padding: 8, paddingTop: tb.show && tb.floating && tb.position === "Top" ? 40 : 8, paddingBottom: tb.show && tb.floating && tb.position === "Bottom" ? 40 : 8 }}>
      <div data-testid="paginated-sheet" style={{ width: rdl.page.width * k, minHeight: rdl.page.height * k, margin: "0 auto", background: "#fff", color: "#201f1e", boxShadow: "0 1px 6px rgba(0,0,0,0.3)", boxSizing: "border-box", padding: `${rdl.page.marginTop * k}px ${rdl.page.marginRight * k}px ${rdl.page.marginBottom * k}px ${rdl.page.marginLeft * k}px`, fontSize: Math.max(8, 3.4 * k) }}>
        {data?.error ? (
          <div role="alert" style={{ color: "#c50f1f" }}>
            Cannot read the data: {data.error}
          </div>
        ) : !table || !mapped || mapped.fields.length === 0 ? (
          <div role="status">Nothing to draw: no column of the report's table is a column of the model.</div>
        ) : !data ? (
          <div role="status">Loading…</div>
        ) : (
          <>
            {rdl.title && <div style={{ fontSize: "1.5em", fontWeight: 600, height: 12 * k }}>{rdl.title}</div>}
            <table style={{ borderCollapse: "collapse", tableLayout: "fixed", width: table.columns.reduce((a, x) => a + x.width, 0) * k }}>
              <thead>
                <tr style={{ height: table.headerHeight * k, borderBottom: "1px solid #605e5c" }}>
                  {table.columns.map((x, i) => (
                    <th key={i} style={{ ...cell, width: x.width * k, textAlign: "left", fontWeight: 600 }}>
                      {x.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pages[no].map((row, ri) => (
                  <tr key={ri} style={{ height: table.rowHeight * k }}>
                    {row.map((v, ci) => (
                      <td key={ci} style={cell}>
                        {v}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
      {problems.length > 0 && (
        <ul data-testid="paginated-notes" style={{ margin: "6px auto 0", maxWidth: rdl.page.width * k, fontSize: 11, color: "#605e5c", paddingLeft: 16 }}>
          {problems.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <div data-testid="paginated" style={{ width, height, position: "relative", display: "flex", flexDirection: tb.position === "Bottom" && !tb.floating ? "column-reverse" : "column", overflow: "hidden" }}>
      {toolbar}
      {paramPane}
      {sheet}
    </div>
  );
}
