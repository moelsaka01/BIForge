# Feature coverage

Status values: **Not started** / **Partial** / **Done-tested** (done requires a passing automated test) / **Deferred** (with reason).
Last updated: 2026-10-15, end of Phase 1 work (see PROGRESS.md). Only Phase 1 features exist; everything else is not started.

| Area | Feature | Status |
| --- | --- | --- |
| Platform | Tauri window launches | Done-tested (app/src-tauri/tests/window_smoke.rs, local + CI) |
| Platform | CI build + tests on Windows | Done-tested (workflow green on windows-latest) |
| Connectivity | CSV import | Not started |
| Connectivity | Excel import | Not started |
| Connectivity | JSON / Parquet import | Not started |
| Connectivity | SQLite / PostgreSQL connectors | Not started |
| Connectivity | ODBC / other database sources | Not started |
| Power Query | M parser (license check first) | Not started |
| Power Query | M evaluator folding to DuckDB SQL | Not started |
| Power Query | Query editor UI + applied steps | Not started |
| Modeling | Tables / columns / data types (read from TMDL, listed in UI tree) | Partial (read-only listing tested in ops.test.ts; no column editing) |
| Modeling | Add / delete table (with model ref + relationship cleanup) | Done-tested (ops.test.ts, session.test.ts); UI input only manually checked |
| Modeling | Add / edit / delete measure (DAX text only, not evaluated) | Done-tested (ops.test.ts); expression is stored, never parsed or run |
| Modeling | Rename table/column/measure, add/edit columns, hierarchies | Not started |
| Modeling | Relationships (create/edit; delete-with-table works) | Not started |
| DAX | Parser | Not started |
| DAX | Filter context + CALCULATE | Not started |
| DAX | Context transition, blank semantics | Not started |
| DAX | DuckDB SQL compilation | Not started |
| DAX | Monaco editor with highlighting | Not started |
| Reports | Pages / canvas | Not started |
| Reports | ECharts visuals (bar, line, table, card) | Not started |
| Reports | Slicers, filters, cross-highlighting | Not started |
| Reports | Themes | Not started |
| Interop | TMDL parser and printer (generic syntax, canonical output) | Done-tested (16 tests in crates/model/tests/tmdl_roundtrip.rs; hand-written fixtures from the public spec) |
| Interop | TMDL files written by Power BI Desktop parse and round-trip | Not started (no Desktop-written samples tested yet; planned Phase 7) |
| Interop | PBIP-shaped project open / save / new (TMDL model + PBIR JSON report) | Done-tested on a hand-written sample (crates/model/tests/project.rs, 15 tests: unmanaged files untouched, unchanged files not rewritten, failed save leaves files intact) |
| Interop | PBIP opens correctly in Power BI Desktop | Not started (our new-project report files follow published schemas but are untested in Desktop) |
| Interop | Semantic model in TMSL (model.bim) | Deferred (clear "not supported yet" error on open; TMDL is the target format) |
| Interop | Report in PBIR-Legacy (single report.json) | Deferred (clear error on open; PBIR is the default format) |
| Interop | Remote semantic model reference (byConnection) | Deferred (clear error on open; local models only) |
| Interop | PBIX read-only import | Not started |
| Core | Document store with transactions, undo/redo, dirty tracking | Done-tested (documentStore.test.ts, 13 tests); history keeps full snapshots (memory grows with model size) |
| Core | Command registry (id, label, enabled state, keytip, shortcut) | Done-tested (registry.test.ts) |
| Core | Autosave + crash-recovery snapshot | Partial: Rust snapshot read/write and TS controller tested with fakes (autosave.test.ts, project.rs); Tauri `invoke` glue and a real crash are not tested |
| Core | Open / save commands wired to disk through Tauri | Partial: Rust command wrappers tested; TS `tauriIO.ts` and dialogs not tested |
| UI | Phase 1 host screen (temporary: toolbar, model tree, recovery banner) | Partial (placeholder; no UI tests, manually verified only that it builds) |
| UI | Ribbon bound to command ids | Not started |
| UI | Classic shell | Not started |
| UI | Modern shell | Not started |
| UI | Per-shell layout persistence | Not started |
| UI | Options > Preview features check of Classic/Modern switches in the real Desktop app | Not started (research task; see research/ui-modes.md open items) |
