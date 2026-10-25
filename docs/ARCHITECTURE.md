# Architecture

Status: implemented through Phase 6; see the notes per phase below.

## Layers
1. **UI (`app/`)** – React + Fluent UI v9. `core/` holds the command registry, document store client and state; `shells/classic` and `shells/modern` contain only layout/ribbon/panel components that dispatch commands. Per-shell layout is persisted separately from the document.
2. **Tauri bridge** – Tauri 2 commands expose the Rust crates to the UI. Query results cross the boundary as Apache Arrow IPC.
3. **Rust crates**
   - `model` – semantic model (tables, columns, relationships, measures) and the text project format mirroring PBIP/TMDL.
   - `engine` – DuckDB integration, data import, SQL execution, Arrow output.
   - `dax` – parser and semantic engine; compiles to DuckDB SQL where semantics allow, hybrid evaluator otherwise (filter context, context transition, blank semantics).
   - `m` – Power Query M parser (reuse of Microsoft's open-source parser pending license check) and evaluator folding steps to SQL.
4. **Storage** – DuckDB only. Model metadata lives in the text project folder, not a database.

## Invariants
- One document store, one engine; shells never contain business logic.
- Every user action is a registered command, so both shells and tests drive the same path.
- Conformance tests in `tests/` (e.g. `tests/dax`) define expected results independent of implementation.

## Phase 1 implementation notes (2026-10-15)
- `crates/model`: `tmdl` (generic TMDL tree + canonical printer; kinds are plain strings, interpreted by callers) and `project` (PBIP-shaped folder: `.pbip`, `<name>.SemanticModel/definition/**/*.tmdl`, `<name>.Report/definition/**/*.json`). Only those managed files are read/written; other files in the folders are never touched. Saves stage temp files first, skip unchanged files, refuse unsafe paths, and delete only stale managed files.
- Project JSON crosses the Tauri boundary as serde JSON (`Project`), and the TS document store holds exactly that shape (`app/src/core/model/types.ts`). Model edits (`app/src/core/model/ops.ts`) operate on the TMDL tree; validation of DAX is not done yet.
- `app/src/core`: `store/documentStore.ts` (transactions on clones, undo/redo, dirty by reference to the saved snapshot), `commands/registry.ts` + `builtin.ts` (the only place UI actions are defined), `session/` (project root, recovery offer, autosave controller, Tauri IO adapter).
- Crash recovery: snapshot of the whole project at `<project root>/.biforge/recovery/project.json` (gitignored), written debounced after edits, removed on save, offered on next open.
- Known limits: history stores full project snapshots; the report side is held as opaque JSON values; new-project report files follow Microsoft's published JSON schemas but have not been opened in Power BI Desktop.

## Phase 4 implementation notes (2026-10-16): reports
- The report is stored as PBIR JSON in `Project.report.files` (and themes in `Project.report.static_resources`), edited only through `app/src/core/report/reportOps.ts` inside document transactions, so every edit is undoable and goes through the command registry (`core/commands/reportCommands.ts`, ids `report.*`). Shapes and the BIForge-only parts are in `research/pbir-report-format.md`.
- Layers in `app/src/core/report`: `fields`, `pbir`, `filters` (model, DAX text, PBIR form), `visualDoc` (typed reads of page and visual JSON, format properties), `queryBuilder` (visual + filters to DAX), `dataLoader` (runs queries through the DaxApi, caches identical ones), `chartOptions` and `tableModels` (results to ECharts options and to table/matrix/card/KPI models), `interactions`, `bookmarks`, `theme`, `condFormat`, `numberFormat`, `formatSchema` (what the Format pane offers), `runtime` (selection, drill, drillthrough: view state that is not part of the document).
- Views in `app/src/views/report`: `ReportView` (toolbar, canvas, tabs, panes), `PageCanvas`, `VisualFrame`, `VisualContent`, `ChartView` (ECharts, SVG renderer), `DomVisuals`, `SlicerView`, `VisualizationsPane`, `FormatPane`, `FiltersPane`, `BookmarksPane`, `PageTabs`. They only render state and dispatch commands.
- Every visual runs its own DAX query (`SUMMARIZECOLUMNS` over the grouping fields, the filter arguments and the measures); a matrix sends one EVALUATE per row/column depth for its subtotals. Report, page, visual and slicer filters are merged per column; a selection in another visual is passed as a TREATAS tuple.
- The Tauri `dax_query` command keeps the loaded DAX engine of the last query (`biforge_engine::dax_bridge::DaxCache`), keyed by the model text and the data stamp of the store (bumped by import, refresh and drop), so a page of visuals does not reload every table for every query.
- Development harness: `cargo run -p biforge-engine --features tools --example report_harness` serves the fixture project and the real engine on 127.0.0.1:1431; `app/harness.html` (served by `npm run dev`) renders the report views against it. It is for manual checks and is not part of the product build.
- Tests that tie the layers together: `tests/reports/query-cases.json` (generated queries and values computed from the CSV files; written by vitest, run on the engine by `crates/engine/tests/it/report_queries.rs`), `tools/pbir-validate` (schema check of the written files), jsdom tests of the views.

## Phase 5 implementation notes (2026-10-16): Power Query
- `crates/m` is pure Rust (no DuckDB): lexer and parser, the symbolic evaluator (`eval.rs`, `stdlib.rs`, `fold.rs`), Applied Steps text edits (`steps.rs`) and the ribbon transforms as data (`transforms.rs`). It talks to the data through the `Backend` trait (describe, small reads, source SQL); `crates/engine/src/m_bridge.rs` implements it over DuckDB and exposes `m_analyze`, `m_preview`, `m_load`.
- A table value is `Rel`: a chain of CTEs, the name of the last, the visible columns with DuckDB types. Every CTE carries `__ord`, the row order; operations that need positions use `row_number() OVER (ORDER BY __ord)`. Scalars inside `each` are `Value::Sql` fragments (column references stay symbolic, constants fold).
- The app side: `core/queries` (project queries, draft, dialogs and ribbon as data, M language), `core/commands/queryCommands.ts` (the `query.*` commands), `views/pq` (the editor). `Session` owns the `QueryDraft` and `applyQueries`.
- Queries in the document: a loaded query is a table with an M partition (`source =` expression), others are TMDL `expression` objects in `expressions.tmdl`. The marker annotation `BIForge.GeneratedM` says BIForge wrote the M; editing removes it and the table then refreshes by running its M.
- Development harness: `cargo run -p biforge-engine --features tools --example pq_harness` + `app/pq-harness.html` (the real engine behind the real editor in a browser).

## Phase 6 implementation notes (2026-10-16): start screen and shells
- `app/src/core/shell`: `settings.ts` (shell, theme, recent projects, per-shell layout; sanitized localStorage JSON), `shellStore.ts` (screen, view, dialog, selection and zoom state; `Session.shell`), `ribbon.ts` (ribbons as data per shell and view; controls name command ids), `windowApi.ts` / `tauriWindow.ts` (window buttons and close guard behind an interface). `core/commands/shellCommands.ts` registers the frame commands (`app.*`, `view.*`, `pane.toggle`, `data.getData`, `file.newBlank`, `file.close`, `app.exit`, `dax.*`, `model.newMeasure`, ...). `file.new`, `file.open`, `file.close` and `app.exit` ask about unsaved changes through a dialog request that re-runs the command with `discard: true`.
- `app/src/views/shell`: `Frame` (title bar, start screen or ribbon + view switcher + view + panes, status bar, dialogs), `StartScreen`, `TitleBar` (with command search), `Ribbon` (renders the data, key tips), `PaneFrame` (collapse to rail, resize), `ViewSwitcher`, `StatusBar`, `Dialogs`, `DaxQueryView`, `TmdlView`, `DataPaneHost`, `shell.css`. `shells/classic` and `shells/modern` only say where the panes go (`ShellSpec`) and wrap `Frame`. `ReportView` takes `zoom`, `onScale` and `docks` instead of drawing its own toolbar and panes.
- Layout per shell is stored apart from the document; recovery snapshots are written and cleared through one queue in `Session` (see recoveryLifecycle.test.ts).
- Development: `app/shell-harness.html` with `cargo run -p biforge-engine --features tools --example report_harness`.
