# BIForge Master Plan (Days 2–4)

## Mission
Recreate Power BI Desktop's features, workflows and UI (Classic and Modern) as an independent open-source Windows app. Scope (changed 2026-10-16): every feature of Power BI Desktop 2.158 except cloud features. docs/INVENTORY.md is the definition of "everything"; COVERAGE.md gives every inventory item a status. Cloud features are removed entirely (no UI, no disabled buttons) and listed once under "Excluded (cloud)" in COVERAGE.md. Never reduce scope silently; record anything deferred in COVERAGE.md as "Deferred" with a reason.

## Architecture (binding)
- One document store + one engine; Classic and Modern are shells only. All user actions are commands in app/core/commands (id, label, enabled-state, handler, keytip, shortcut). Ribbons, menus, shortcuts and context menus are data that reference command ids. Shell components contain no business logic.
- Document = PBIP-shaped project folder: TMDL for the model (crates/model), PBIR-style JSON for the report, plus BIForge extras in a namespaced folder. Report theme and visual defaults belong to the document.
- Per-shell layout (pane positions, sizes, collapsed state, ribbon mode) is stored in app settings, not the document.
- Rust engine owns data: DuckDB for storage/execution, Arrow for transfer to the UI. The UI never computes aggregates itself.
- Undo/redo is implemented at the document-store level via command transactions.

## UI modes
- Modern: single-line ribbon; on-object interaction; modern Format pane; new Power Query editor; modern explore canvas; pane color refresh; Fluent 2 default theme for NEW reports (newVisualDefaults2026 equivalent).
- Classic: multiline ribbon; modern Format pane without on-object (2.158 has no legacy Format pane toggle); current Power Query editor; older visual defaults for NEW reports.
- Switching modes never alters an existing document.
- Sources: research/ui-modes.md, research/ui-ribbon-commands.md.

## Phases (one per session; stop at the end of each)
1. Model and project: TMDL parser + printer in crates/model with round-trip tests on doc-derived samples; PBIP-shaped project open/save; document store, command registry and undo/redo in app/core; autosave + crash recovery file.
2. Data import and views: DuckDB import for CSV, Excel, JSON, Parquet, plus SQLite/PostgreSQL connectors; refresh; Data view (virtualized grid, column types, sort); Model view (table cards, drag-to-create relationships, cardinality, cross-filter direction, active/inactive); Data pane.
3. DAX engine: lexer/parser covering research/dax-parser.md grammar and error codes; semantic engine with filter context, row context, context transition, CALCULATE/CALCULATETABLE, iterators, relationship functions (RELATED, RELATEDTABLE, USERELATIONSHIP, CROSSFILTER), blank semantics, VAR/RETURN; measures and calculated columns; compile to DuckDB SQL where semantics allow, engine-side evaluation otherwise. Function tranche order: aggregation, logical, math, text, filter, date/time, time intelligence, statistical. DAX editor with Monaco (syntax highlighting, IntelliSense from our catalog, error squiggles). Runner for tests/dax cases.
4. Reports: canvas with pages and tabs; Visualizations, Data and Filters panes; visuals via ECharts (bar/column clustered+stacked+100%, line, area, combo, pie, donut, scatter, table, matrix, card, multi-row card, KPI, gauge, treemap, funnel, waterfall, map placeholder marked Deferred); slicers; cross-filter and cross-highlight; drill down/up and drillthrough; tooltips; conditional formatting; bookmarks; themes (JSON); Format pane in both modes.
5. Power Query: reuse Microsoft's open-source M parser if license-compatible; M evaluator folding to DuckDB SQL; Applied Steps; editor UI with ribbon built from the inventory; transforms: types, filter, sort, remove/keep rows and columns, split, replace, group by, merge, append, pivot/unpivot, custom and conditional columns, fill, dedupe, folder import; query dependencies view; Advanced Editor.
6. Shells: start screen (see "Phase 6: Start screen" below); full Classic and Modern ribbons from the inventory (tabs, groups, contextual tabs) bound to commands; keytips; keyboard shortcuts; context menus; pane docking and resizing; layout persistence per shell; mode switch in Options.
Phases 7 to 13 form the parity roadmap (rewritten 2026-10-16), ordered by user impact. Each ends with tests, COVERAGE.md/PROGRESS.md updates, commit, push, CI green, report.
7. **Remaining report features, all visuals, complete Format pane.** Every visual in INVENTORY.md (ribbon chart, decomposition tree, key influencers, smart narrative, maps with Natural Earth boundaries and no online tiles, shape map, custom visual file import), text box / shapes / images / buttons / page navigation, multi-select, align / distribute / group, Selection pane, sync slicers, mobile layout, personalize visuals, on-object formatting (Modern), every Format pane card of every visual, auto date/time hierarchies, conditional-format icons, bookmark groups and spotlight.
8. **All local connectors.** SQL Server (tiberius, M `Sql.Database`), generic ODBC (odbc-api), MySQL / PostgreSQL / SQLite / Excel / JSON through DuckDB extensions where they replace custom code, Web / REST / OData (reqwest), XML (quick-xml), PDF tables, Access, local Analysis Services, folder sources; a Navigator and credential/privacy dialogs for each.
9. **Remaining Power Query transforms and M functions.** Everything in the Power Query ribbon (date/time, number statistics, extract, parse, merge columns, column from examples, detect type, transpose, parameters, query groups, data source settings, error handling, column quality / distribution / profile, function queries, `section` documents) and the M standard library, with Desktop-recorded conformance cases (tests/m).
10. **Remaining modeling features.** Hierarchies, calculated tables and columns UI, calculation groups, field parameters, RLS and View as, quick measures, what-if parameters, date tables and auto date/time, sort by column, data categories, format strings, display folders, perspectives, translations, aggregations, full Model view (layouts, hide/show), DAX query view complete (DEFINE COLUMN/FUNCTION), user-defined functions.
11. **Remaining DAX functions.** Window functions (INDEX, OFFSET, WINDOW, RANK, ROWNUMBER, ORDERBY, PARTITIONBY, MATCHBY), financial, parent-child (PATH*), LINEST/LINESTX, ROLLUP / ISSUBTOTAL / ISINSCOPE, calculation-group and identity functions, INFO.*, remaining table functions, enhanced time intelligence; conformance cases recorded from Desktop for each family (tools/dax-record).
12. **Export/print, performance analyzer, full Options dialog, accessibility.** Export to PDF (WebView2 printing) and PNG, export data, print; Performance analyzer; every remaining Options page setting; keyboard navigation, screen-reader names, high contrast, the keyboard shortcut table from the inventory.
13. **Installer and release.** NSIS installer via the Tauri bundler, PBIP export/import verified against Microsoft samples, read-only PBIX import if feasible, README, docs/USER_GUIDE.md, tag v0.1.0 and GitHub release.

## Rules for every session
- Start by reading CLAUDE.md, this plan, docs/COVERAGE.md and docs/PROGRESS.md. Do not reread research/_raw.
- Work only on the current phase. If blocked, record it and move to the next item in the phase.
- Every feature needs an automated test (Rust unit/integration, Vitest, or Playwright/WebDriver UI test). No test = not Done.
- No mocks, stubs or hardcoded data presented as working. Unfinished UI shows a visible "Not yet implemented" state and is listed in COVERAGE.md.
- Errors: Rust uses typed errors (thiserror) surfaced to the UI as user-readable messages; no panics on user input; failed imports/queries never corrupt the document.
- Security: credentials stored via Windows Credential Manager, never in project files or logs.
- Token budget: read files selectively; use rg; don't print large outputs.
- End of phase: run all tests, update COVERAGE.md and PROGRESS.md (what works, what's partial, what failed), commit with conventional messages, push, confirm CI green, report a short summary and stop.

## Phase 6: Start screen
Described from Power BI Desktop 2.158 (reference screenshots are local only, in research/_raw/reference-screens/, gitignored; never commit them). Replicate the layout and workflow; use original icons, and our own wording wherever the original text is Microsoft branding.
- Title bar: save, undo and redo icons; document title; a centered search box; settings, a light/dark theme toggle, window controls (no sign-in area).
- Left navigation: Home and Open at the top; Options and settings, About at the bottom (no Sign in).
- Main area: the heading "Select a data source or start with a blank report" with cards: Blank report, Excel workbook, SQL Server, Learn with sample data, Get data from other sources. A collapsible "Recommended" section with a carousel. The Recent list, with a keyword filter and a Filter dropdown.
- Cloud items (OneLake catalog, Sign in, Shared with me, Publish, Sensitivity) are not shown at all (scope change 2026-10-16).
- Every card and navigation item dispatches a registered command; the start screen holds no logic of its own.
