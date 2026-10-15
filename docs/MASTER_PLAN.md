# BIForge Master Plan (Days 2–4)

## Mission
Recreate Power BI Desktop's features, workflows and UI (Classic and Modern) as an independent open-source Windows app. Scope is full parity as the stretch target; COVERAGE.md measures reality. Never reduce scope silently; record anything deferred in COVERAGE.md as "Deferred" with a reason.

## Architecture (binding)
- One document store + one engine; Classic and Modern are shells only. All user actions are commands in app/core/commands (id, label, enabled-state, handler, keytip, shortcut). Ribbons, menus, shortcuts and context menus are data that reference command ids. Shell components contain no business logic.
- Document = PBIP-shaped project folder: TMDL for the model (crates/model), PBIR-style JSON for the report, plus BIForge extras in a namespaced folder. Report theme and visual defaults belong to the document.
- Per-shell layout (pane positions, sizes, collapsed state, ribbon mode) is stored in app settings, not the document.
- Rust engine owns data: DuckDB for storage/execution, Arrow for transfer to the UI. The UI never computes aggregates itself.
- Undo/redo is implemented at the document-store level via command transactions.

## UI modes
- Modern: single-line ribbon; on-object interaction; modern Format pane; modern explore canvas; pane color refresh; Fluent 2 default theme for NEW reports (newVisualDefaults2026 equivalent).
- Classic: multiline ribbon; legacy Format pane (no on-object); older visual defaults for NEW reports.
- Switching modes never alters an existing document.
- Sources: research/ui-modes.md, research/ui-ribbon-commands.md.

## Phases (one per session; stop at the end of each)
1. Model and project: TMDL parser + printer in crates/model with round-trip tests on doc-derived samples; PBIP-shaped project open/save; document store, command registry and undo/redo in app/core; autosave + crash recovery file.
2. Data import and views: DuckDB import for CSV, Excel, JSON, Parquet, plus SQLite/PostgreSQL connectors; refresh; Data view (virtualized grid, column types, sort); Model view (table cards, drag-to-create relationships, cardinality, cross-filter direction, active/inactive); Data pane.
3. DAX engine: lexer/parser covering research/dax-parser.md grammar and error codes; semantic engine with filter context, row context, context transition, CALCULATE/CALCULATETABLE, iterators, relationship functions (RELATED, RELATEDTABLE, USERELATIONSHIP, CROSSFILTER), blank semantics, VAR/RETURN; measures and calculated columns; compile to DuckDB SQL where semantics allow, engine-side evaluation otherwise. Function tranche order: aggregation, logical, math, text, filter, date/time, time intelligence, statistical. DAX editor with Monaco (syntax highlighting, IntelliSense from our catalog, error squiggles). Runner for tests/dax cases.
4. Reports: canvas with pages and tabs; Visualizations, Data and Filters panes; visuals via ECharts (bar/column clustered+stacked+100%, line, area, combo, pie, donut, scatter, table, matrix, card, multi-row card, KPI, gauge, treemap, funnel, waterfall, map placeholder marked Deferred); slicers; cross-filter and cross-highlight; drill down/up and drillthrough; tooltips; conditional formatting; bookmarks; themes (JSON); Format pane in both modes.
5. Power Query: reuse Microsoft's open-source M parser if license-compatible; M evaluator folding to DuckDB SQL; Applied Steps; editor UI with ribbon built from the inventory; transforms: types, filter, sort, remove/keep rows and columns, split, replace, group by, merge, append, pivot/unpivot, custom and conditional columns, fill, dedupe, folder import; query dependencies view; Advanced Editor.
6. Shells: full Classic and Modern ribbons from the inventory (tabs, groups, contextual tabs) bound to commands; keytips; keyboard shortcuts; context menus; pane docking and resizing; layout persistence per shell; mode switch in Options.
7. Ship: export page to PDF and PNG; PBIP export/import verified against Microsoft samples; read-only PBIX import if feasible (else Deferred); Windows installer via Tauri bundler (NSIS); signed-off README, docs/USER_GUIDE.md; tag v0.1.0 and create a GitHub release.

## Rules for every session
- Start by reading CLAUDE.md, this plan, docs/COVERAGE.md and docs/PROGRESS.md. Do not reread research/_raw.
- Work only on the current phase. If blocked, record it and move to the next item in the phase.
- Every feature needs an automated test (Rust unit/integration, Vitest, or Playwright/WebDriver UI test). No test = not Done.
- No mocks, stubs or hardcoded data presented as working. Unfinished UI shows a visible "Not yet implemented" state and is listed in COVERAGE.md.
- Errors: Rust uses typed errors (thiserror) surfaced to the UI as user-readable messages; no panics on user input; failed imports/queries never corrupt the document.
- Security: credentials stored via Windows Credential Manager, never in project files or logs.
- Token budget: read files selectively; use rg; don't print large outputs.
- End of phase: run all tests, update COVERAGE.md and PROGRESS.md (what works, what's partial, what failed), commit with conventional messages, push, confirm CI green, report a short summary and stop.
