# Paginated report visual (own notes)

Source of the property list: the visual styles of Desktop 2.158 (objects of `rdlVisual`): `autoFilter.show`, `export.*` (show plus
eight formats), `parameterMapping.mappings`, `reportInfo.{reference,reportId,workspaceId}`, `toolbar.{show,position,useFloatingToolbar,
pageNavigation,paramButton,openReportButton}` plus the container cards every visual has.

## What BIForge does with them (own design, not checked against Desktop)
- There is no report server. `Insert > Paginated report` reads a local `.rdl` once and stores its text in the visual
  (`reportInfo.rdl`, `reportInfo.rdlName`: BIForge extensions of the visual JSON). Desktop cannot open these visuals.
- `reportInfo.reportId`, `reportInfo.workspaceId`, `reportInfo.reference` and `toolbar.openReportButton` name or open a report
  in the Power BI service: excluded with the cloud features (`cloudOnly.json`).
- Subset of RDL drawn (`app/src/core/report/rdl.ts`): page size and margins, the first Tablix (header row, last row as the detail
  row, column widths), `=Fields!Name.Value` cells, the data set field names, report parameters (prompt, valid values, defaults,
  multi value). Everything else is listed under the sheet as not drawn.
- Data: each data set field is resolved to a model column or measure (`Table[Column]`, `'Table'.Column` or a unique column name);
  the table is read through the same query pipeline as the other visuals (`ReportData.rows`).
- Pages: rows per page = (page height - margins - title - header row) / row height. Page navigation walks them.
- Parameters: the Parameters pane lists the report's parameters; a chosen value becomes an `in` filter on the mapped column.
  `parameterMapping.mappings` is a JSON object `{"Parameter":"Table[Column]"}`; a parameter with no mapping uses the column of the
  data set field of the same name.
- Auto filter (default on, a reading): on = the filters of the report, the page, the slicers and a drillthrough apply like
  for any visual; off = only the visual's own filters do.
- Toolbar `position`: 0 = Top, 1 = Bottom (a reading); `useFloatingToolbar` overlays the toolbar on the page.
- Export writes CSV, XML, MHTML (a base64 HTML part) and PDF (the browser's print dialog on the pages). Excel, Word, PowerPoint and
  accessible PDF are not written: their four `export` properties stay undrawn and the menu says so.
