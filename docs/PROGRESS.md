# Progress log

## 2026-10-15 (Day 1)
- Repo contained only LICENSE (Apache-2.0).
- Added .gitignore, README, CLAUDE.md, docs skeletons.
- Toolchain check: Rust 1.94.1 (msvc, in ~/.cargo/bin, not on bash PATH), Node 24.14, npm 11.9, VS 2022 BuildTools with MSVC 14.44, WebView2 present, gh authenticated.
- Reviewed rea documentation (no run yet). Awaiting user go-ahead before running against Power BI.
- Scaffolded workspace: root Cargo workspace (crates engine/dax/m/model as placeholders with trivial tests), `app/` Vite + React 19 + Fluent UI v9 + Tauri 2 (`app/src-tauri`), `tests/dax`, CI workflow.
- Verified locally: `npm run build`, `npm test` (1 test), `cargo test --workspace` pass; `npx tauri dev` opened a window titled "BIForge" (manual check only).
- Power BI Desktop not found at the default MSI path; no Ghidra/Hopper/IDA installed. rea not installed or run (awaiting user review).
- Added `app/src-tauri/tests/window_smoke.rs`: launches the real binary, waits for a visible top-level window titled "BIForge" owned by that PID, kills only its own child. Passes locally.
- Added "Process safety" rule to CLAUDE.md (never kill processes not started by us; PID only).
- Looked for Power BI Desktop (Appx package, registry uninstall keys, Program Files, LocalAppData, running process): not found on this machine. No .NET SDK and no ilspycmd present. `rea setup --dry-run --client claude_code` reviewed; nothing applied.

## 2026-10-15 (Day 1, continued): reverse engineering group 1
- Installed .NET SDK 9.0.319 and ilspycmd 9.1.0.7988 (newer ilspycmd versions fail to install on this SDK). Applied `rea setup` for Claude Code (adds `mcpServers.rea` to ~/.claude.json plus a skill; backup at ~/.claude.json.rea.backup). The MCP tools need a Claude Code restart to load; the CLI was used meanwhile.
- Power BI Desktop 2.158.1304.0 analysed read-only. Findings in `research/ui-ribbon-commands.md`: PBIDesktop.exe is a thin launcher; the UI is JavaScript in WebView2 hosted by Microsoft.PowerBI.Client.Windows.dll; ribbon layout mode is the `PreferredRibbonMode` setting (Multiline default, SingleLine); 7 main and 5 contextual report-ribbon tabs; the Power Query editor ribbon has a 700-entry command enum.
- rea limitation: cannot admit metadata for the largest assemblies; ilspycmd listing used instead.
- Added `tools/re/` helper scripts and `research/dax-harness-design.md` (design only, awaiting review).
- Not verified: what "Modern" refers to. Keyboard shortcuts and dialogs not yet extracted.

## 2026-10-15 (Day 1, continued): Classic/Modern flags and group 2
- `research/ui-modes.md`: Classic vs Modern mapping from user settings and feature switches (onObject, useModernFormatPane, ribbon switches, styling). How users toggle on-object is unverified.
- `research/pbip-tmdl-format.md`: PBIP/PBIR/TMDL layout and rules from public docs; gaps listed (no binary work needed so far).
- DAX harness approved by owner (recorded outputs on our own data are acceptable).

## 2026-10-15 (Day 1, continued): group 3
- `research/dax-parser.md`: DAX parser assembly analysed with rea (it admitted metadata for this 315-type assembly) plus type listing. Findings: token/keyword set, 16 syntax error codes, function category/role/parameter-role model, ~210 statically named functions; full catalog is supplied by the engine at runtime, so it will be recorded through the black-box harness.
- Native engine (msmdsrv.exe) was not analysed, per instructions; no Ghidra installed.

## 2026-10-15: Phase 1 (model and project)
- Added `docs/MASTER_PLAN.md` (verbatim) and the "one phase per session" line in CLAUDE.md.
- `crates/model`: TMDL parser + canonical printer (16 tests, hand-written fixtures from the public spec incl. messy/CRLF/BOM/fenced cases and error cases) and PBIP-shaped project open/save/new + recovery snapshot (15 tests, hand-written Retail sample).
- App: Tauri commands (tested wrappers), TS document store with undo/redo (13 tests), command registry (12), model ops (15), session + autosave/recovery with fake IO (21). Total frontend tests: 62.
- Temporary host screen (toolbar, model tree, recovery banner); marked as placeholder in the UI and in COVERAGE.md.
- Bugs found by tests while building: fixture/test indentation mistakes only (no parser defects found); clippy `manual_contains` fixed.
- Not done / not verified: Desktop-written TMDL and PBIP samples; opening our files in Power BI Desktop; Tauri glue and UI have no automated tests; Options > Preview features check (user asked for it "later").

## 2026-10-15: Phase 2 (data import and views)
- crates/engine: DuckDB (bundled, json + parquet features) store per project at <root>/.biforge/data.duckdb (the folder ignores itself via its own .gitignore). CSV/JSON/Parquet are read inside DuckDB; Excel (calamine), SQLite (rusqlite) and PostgreSQL (postgres crate, no TLS) are read row-wise and appended. An import builds a staging table and swaps it in, so a failed import or refresh keeps the old data. Paged, sortable row fetch; column stats; cardinality hints. 13 integration tests (one needs a PostgreSQL server).
- Passwords: Windows Credential Manager through the keyring crate; the source description stored in the document (annotation BIForge.Source on the table) has no secret.
- app/src-tauri: DataService + Tauri commands (tested without a window). Bug found by its test: re-opening the same project conflicted with our own DuckDB file lock; the old store is now released first.
- App core: applyImport, relationship ops (a second path between tables is created inactive), session import/refresh/refresh-all, commands data.import, data.refreshTable, data.refreshAll, model.add/update/deleteRelationship, all undoable.
- Views: Data pane, Data view (own virtualization + page cache), Model view, Import dialog, wired into the temporary host screen. Frontend tests: 98 (jsdom + testing-library added as dev dependencies).
- CI: starts the runner's PostgreSQL on port 5433 and sets BIFORGE_TEST_PG / BIFORGE_REQUIRE_PG so the connector test cannot be silently skipped there.
- Not verified: the real app UI by hand (import dialog, drag in a real WebView), the PostgreSQL connector locally (it passed in CI), Excel formats other than xlsx, opening imported tables in Power BI Desktop.
- Known gaps are listed in the Connectivity and UI rows of COVERAGE.md (no Arrow transfer, memory-bound Excel/SQLite/PostgreSQL loads, fixed card layout, no TLS).
- Environment: one cargo run failed once because Windows Application Control blocked a build script (os error 4551); a rerun worked.

## 2026-10-15: pre-Phase 3 housekeeping
- research/ui-modes.md: Options > Preview features as verified by the owner in Desktop 2.158 (on-object and the new Power Query experience are preview toggles, off by default; no legacy Format pane toggle; Enhanced DAX Time Intelligence preview, off; PBIP with TMDL + PBIR enabled). MASTER_PLAN UI-mode lines adjusted to match (Classic keeps the modern Format pane).
- MASTER_PLAN: Phase 6 start screen item. COVERAGE: Phase 5 priority (TMDL partitions with M source expressions for Desktop interop), new Power Query editor follow-up, enhanced DAX time intelligence (later), start screen and its deferred cloud items.
- Bugs from the owner's manual test of Phase 2, each with a regression test:
  - Host banner said no features were implemented; it now lists what works and what does not (info.ts, info.test.ts).
  - Recovery banner in a fresh session after an import: the autosave snapshot written by the current run was offered as a crash recovery when the project was opened again in the same run. The session now remembers which snapshots it wrote and only offers snapshots from an earlier run; snapshots are compared with sorted keys, and a new project clears a snapshot left in its folder (recoveryOwnership.test.ts). I could not reproduce the exact click path from the report; the test covers the new → import → autosave → open path.
  - Decimal cells showed DuckDB's text ("1504210000000.0"); they now use Power BI's default General number format (15 significant digits, scientific notation only beyond 1E+15 / below 1E-05) (format.test.ts, DataView test).

## 2026-10-15: Phase 3 (DAX engine), part 1: parser and semantic core
- Fixture for the DAX harness: `tools/dax-fixtures/generate.mjs` writes six deterministic CSVs to tests/dax/fixtures (Sales 241 rows with unmatched keys, blank values, a return, an out-of-range ship date; Date 2023-2024; Customer, Product, Promotion, Budget). Build steps for the Power BI Desktop report in tests/dax/fixtures/README.md (saved as PBIP under research/_raw, gitignored).
- crates/dax: lexer, parser (expression / formula / query modes, 16 syntax error codes), function catalog (316 entries, own wording, signature grammar with arity), binder, evaluator. Semantics documented with sources and open questions in research/dax-semantics.md.
- Semantic core: expanded-table filter context, overwrite and intersection rules, boolean and table filters, ALL/ALLEXCEPT/REMOVEFILTERS/KEEPFILTERS, context transition (duplicate rows), USERELATIONSHIP, CROSSFILTER, bidirectional and many-to-many cross-filters, blank row, RELATED/RELATEDTABLE, EARLIER/EARLIEST, lazy VAR, measures with cycle detection, calculated columns in dependency order, queries with DEFINE/EVALUATE/ORDER BY/START AT. 53 functions implemented (the ones the core needs); the rest of the catalog reports "not implemented".
- SQL: aggregations compile to DuckDB SQL when provably equivalent; the engine crate implements the DAX data source and SQL executor over the project store. Cross-check test runs 228 measure/context pairs on the fixture data both ways.
- Tests: dax unit 19, parser 16, semantics 41, engine dax_sql 3. Four semantic tests failed on the first run; all four were arithmetic mistakes in my hand-computed expectations (checked against the data table), not engine defects.
- Not done yet (after the model switch): function tranches, Monaco editor, measure UI, tests/dax runner and recorder; no recorded cases yet, so no conformance pass rate.
- Environment: Windows Application Control blocked a cargo build script once more (os error 4551); deleting that build-script folder and rebuilding worked.
