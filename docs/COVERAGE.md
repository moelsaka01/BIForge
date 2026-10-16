# Feature coverage

Status values: **Not started** / **Partial** / **Done-tested** (done requires a passing automated test) / **Deferred** (with reason).
Last updated: 2026-10-15, end of Phase 3 work (see PROGRESS.md). Phases 1 to 3 exist; the report canvas, Power Query and the shells are not started.

| Area | Feature | Status |
| --- | --- | --- |
| Platform | Tauri window launches | Done-tested (app/src-tauri/tests/window_smoke.rs, local + CI) |
| Platform | CI build + tests on Windows | Done-tested (workflow green on windows-latest) |
| Connectivity | CSV import (auto types, delimiter, header option) | Done-tested (crates/engine/tests/import.rs) |
| Connectivity | Excel import (sheet pick, header row, dates, duplicate headers) | Done-tested for .xlsx (calamine also reads .xls/.xlsb/.ods through the same code, untested) |
| Connectivity | JSON / Parquet import | Done-tested (JSON array of objects; Parquet written by DuckDB itself) |
| Connectivity | SQLite connector (pick table, import) | Done-tested |
| Connectivity | PostgreSQL connector (list tables, import, password in Windows Credential Manager) | Done-tested in CI against a real PostgreSQL (run 38754396338); the test is skipped locally unless BIFORGE_TEST_PG is set (no server on the dev machine). No TLS yet. Whole tables only (no custom SQL). |
| Connectivity | Credentials in Windows Credential Manager, never in project files | Done-tested (round trip with the real store; source specs contain no secret) |
| Connectivity | Refresh (one table, all tables; a failed refresh keeps the old data) | Done-tested (engine staging swap + session tests) |
| Connectivity | Row transfer to the UI as Arrow | Deferred: grid pages travel as JSON text (every cell a string); Arrow IPC when visuals need bulk data |
| Connectivity | Large imports | Partial: Excel/SQLite/PostgreSQL read the whole source into memory before loading; CSV/JSON/Parquet stream inside DuckDB |
| Connectivity | ODBC / other database sources | Not started |
| Power Query | M parser (license check first) | Not started |
| Power Query | M evaluator folding to DuckDB SQL | Not started |
| Power Query | Query editor UI + applied steps | Not started |
| Power Query | Two editor UIs: Modern shell uses the "New Power Query experience" editor, Classic the current editor (both are Desktop 2.158 options, new one off by default; see research/ui-modes.md) | Not started (Phase 5 follow-up) |
| Power Query | **PRIORITY (Phase 5):** imported tables get TMDL partitions with M source expressions, so Power BI Desktop can open BIForge projects | Not started |
| Modeling | Tables / columns / data types (read from TMDL, listed in UI tree) | Partial (read-only listing tested in ops.test.ts; no column editing) |
| Modeling | Add / delete table (with model ref + relationship cleanup) | Done-tested (ops.test.ts, session.test.ts); UI input only manually checked |
| Modeling | Add / edit / delete measure (DAX text only, not evaluated) | Done-tested (ops.test.ts); expression is stored, never parsed or run |
| Modeling | Rename table/column/measure, add/edit columns, hierarchies | Not started |
| Modeling | Imported tables get typed columns + a source annotation (BIForge.Source); refresh keeps user edits and measures and drops relationships on vanished columns | Done-tested (tables.test.ts, TMDL round trip in tmdl_roundtrip.rs). Imported tables have no partition, so Power BI Desktop is not expected to load them (interop untested) |
| Modeling | Relationships: create, edit cardinality, cross-filter direction, active/inactive, delete; ambiguity check | Done-tested (relationships.test.ts, dataSession.test.ts). Many-to-many is stored; its semantics wait for the DAX engine |
| Modeling | Relationship cardinality detected from the data | Done-tested (engine suggest_relationship, ModelView test) |
| DAX | Lexer + parser (expressions, Name = formula, queries with DEFINE/EVALUATE/ORDER BY/START AT; all token types and the 16 syntax error codes of research/dax-parser.md) | Done-tested (crates/dax/tests/parser.rs, lexer unit tests). List separator is "," only (no ";" locale form) |
| DAX | Function catalog (317 functions: category, signature, own-words description; arity checks) | Done-tested (catalog unit tests, parser.rs). Signatures written from public docs, not yet checked against the engine's discovery rowset (harness) |
| DAX | Filter context, CALCULATE/CALCULATETABLE (boolean and table filters, ALL, ALLEXCEPT, REMOVEFILTERS, KEEPFILTERS, overwrite/intersection rules, expanded tables) | Done-tested (crates/dax/tests/semantics.rs). Rules and open questions in research/dax-semantics.md; checked against recorded Desktop results (research/dax-semantics.md); multi-column filters spanning several tables are untested. ALLSELECTED and ALLCROSSFILTERED are in the filter tranche row |
| DAX | Relationships: one-to-many propagation, bidirectional, many-to-many, inactive + USERELATIONSHIP, CROSSFILTER, blank row for unmatched keys, RELATED, RELATEDTABLE | Done-tested (semantics.rs) |
| DAX | Row context, context transition (duplicate rows), EARLIER/EARLIEST, blank semantics, VAR/RETURN (lazy, table variables), measures (cycle detection), calculated columns (dependency order, cycles reported) | Done-tested (semantics.rs, value.rs unit tests). Calculated columns are computed in memory, not stored in DuckDB |
| DAX | Query execution (EVALUATE, DEFINE MEASURE/VAR/TABLE, ORDER BY, START AT) | Done-tested (semantics.rs). DEFINE COLUMN and DEFINE FUNCTION report "not implemented" |
| DAX | Functions implemented | Partial: 268 of the 317 catalog functions (APPROXIMATEDISTINCTCOUNT is registered but fails exactly like an imported model in Desktop, where it is DirectQuery only) (every category except the ones listed in the next row). Implemented names are listed by `biforge_dax::functions::implemented_names()`; a test checks each is in the catalog exactly once. Every other function reports "not implemented" at bind time (a warning in the editor) |
| DAX | Not implemented (reported, never faked) | Window functions (INDEX, OFFSET, WINDOW, RANK, ROWNUMBER, ORDERBY, PARTITIONBY, MATCHBY), financial (XIRR, XNPV, FV, PV, PMT, NPER, RATE), parent-child (PATH*), LINEST/LINESTX, ROLLUP*/ADDMISSINGITEMS/TOPNSKIP/SAMPLE/DETAILROWS, ISINSCOPE/ISSUBTOTAL, calculation-group and user-identity functions (SELECTEDMEASURE*, USERNAME, ...), INFO.VIEW.*, COLUMNSTATISTICS, TOCSV/TOJSON, NAMEOF, LOOKUP, SUBSTITUTEWITHINDEX, EXTERNALMEASURE, DEFINE COLUMN/FUNCTION |
| DAX | Aggregation tranche (AVERAGEA, MINA/MAXA, PRODUCT(X), APPROXIMATEDISTINCTCOUNT) | Done-tested (crates/dax/tests/tranche_agg_logic.rs). APPROXIMATEDISTINCTCOUNT counts exactly. Result types and the A-function rules were corrected from the recordings |
| DAX | Logical and information tranche (IF.EAGER, IFERROR, SWITCH, BIT*, ISERROR, ISNUMBER/ISTEXT/ISNONTEXT/ISLOGICAL, ISEVEN/ISODD, CONTAINS*, LOOKUPVALUE, HASONEFILTER, USERCULTURE) | Done-tested (tranche_agg_logic.rs). LOOKUPVALUE only with search columns of the result column's table (other tables report not implemented); whether it ignores the filter context is an open question for the recorder |
| DAX | Math tranche (51 functions: rounding, trig, logs, integer math, CURRENCY, CONVERT, RAND) | Done-tested (tranche_math.rs). BLANK counts as 0 and result types (Integer vs Number) are our reading; recorded cases pass |
| DAX | Text tranche (LEFT/RIGHT/MID/LEN/FIND/SEARCH/REPLACE/SUBSTITUTE/..., CONCATENATEX, FIXED, VALUE, FORMAT) | Done-tested (tranche_text.rs, fn_text.rs unit tests). FORMAT supports the common numeric (custom sections, named formats, E+), date/time and Yes/No formats of the en-US culture; other format strings may differ from Power BI |
| DAX | Filter and table tranche (ALLSELECTED, ALLCROSSFILTERED, FILTERS, NONVISUAL, GENERATE(ALL), GENERATESERIES, UNION/INTERSECT/EXCEPT, NATURAL joins, TOPN, GROUPBY/CURRENTGROUP, DATATABLE, SUMMARIZE with added columns) | Done-tested (tranche_filter.rs). ALLSELECTED uses a shadow filter context (set by group-by and context transition); ROLLUP/subtotals are not supported |
| DAX | Date/time tranche (DATE, TIME, parts, WEEKDAY/WEEKNUM, EDATE/EOMONTH, DATEDIFF, YEARFRAC, NETWORKDAYS, NOW/TODAY, DATEVALUE/TIMEVALUE) | Done-tested (tranche_date.rs). BLANK counts as serial 0 (12/30/1899); recorded cases pass |
| DAX | Time intelligence tranche (37 functions: DATES*, DATEADD, SAMEPERIODLASTYEAR, PARALLELPERIOD, PREVIOUS/NEXT*, STARTOF/ENDOF*, FIRST/LASTDATE, FIRST/LASTNONBLANK(VALUE), OPENING/CLOSINGBALANCE*, TOTAL*TD, CALENDAR(AUTO)) and marked date tables | Done-tested (tranche_time.rs). Default (not the enhanced preview) behavior; DATEADD shifts day by day (no whole-period alignment) and anchors for PREVIOUS*/NEXT*/STARTOF* are our reading: open questions for the recorder |
| DAX | Statistical tranche (MEDIAN, GEOMEAN, PERCENTILE.*, STDEV/VAR (.S/.P) and X forms, RANKX, RANK.EQ, NORM/T/CHISQ/BETA/EXPON/POISSON distributions, CONFIDENCE.*) | Done-tested (tranche_stats.rs; distribution values checked against published table values to 1e-9). Sample statistics over one value return BLANK (open question) |
| DAX | DuckDB SQL compilation (SUM, AVERAGE, MIN/MAX non-text, COUNT, COUNTROWS under value filters with LEFT JOIN relationship paths; engine fallback otherwise) | Done-tested on the fixture data (crates/engine/tests/dax_sql.rs: 228 measure/context pairs evaluated both ways, results equal, SQL used where allowed). Iterators, calculated columns and cross-filtered tables are evaluated by the engine over columns loaded into memory |
| DAX | tests/dax conformance runner (crates/engine/tests/dax_conformance.rs) and recorder (tools/dax-record: record.mjs, probe.mjs, add-cases.mjs, query.ps1) | Done-tested. The recorder ran against Power BI Desktop 2.158.1304.0 on 2026-10-16: **308 cases recorded; 230 of the first 307 matched before any engine change (75%); 308 of 308 pass now**, after the engine was changed to follow the recordings (a fit to them, not independent validation). 55 recorded results are Desktop errors (the engine must fail too). Known remaining differences (no case): IFERROR result-type unification, FORMAT(TRUE(), "General"); multi-column cross-table filters untested. See research/dax-semantics.md, "Recorded from Power BI Desktop" |
| DAX | Monaco DAX editor: syntax highlighting, IntelliSense (functions from the catalog with signatures, tables, columns, measures, keywords), signature help, hover, error and warning squiggles | Partial: the language logic is Done-tested (core/dax/language.test.ts, editor.rs diagnostics tests); the Monaco wiring (monaco.ts) was exercised by hand in a browser (highlighting, completion list, squiggles, auto-closed bracket fix) and has no automated test |
| DAX | Measure editor view (create, edit, delete measures through the command registry; evaluate the draft; split by any column; plain text fallback when the editor cannot load) | Done-tested (jsdom: views/measureEditor.test.tsx with a fake DAX API; Rust: app/src-tauri/src/dax.rs evaluates over a real DuckDB store). Each evaluation rebuilds the model and reloads the tables (no cache), results are cut at 10,000 rows; the real window was not driven by hand |
| DAX | "Enhanced DAX Time Intelligence" (Desktop 2.158 preview, off by default): we match the default behavior first; the enhanced variant is a later item | Not started (later) |
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
| Core | Autosave + crash-recovery snapshot | Partial: Rust snapshot read/write and TS controller tested with fakes (autosave.test.ts, recoveryOwnership.test.ts, project.rs). The recovery offer only appears for snapshots from an earlier run of the app. Tauri `invoke` glue and a real crash are not tested |
| Core | Open / save commands wired to disk through Tauri | Partial: Rust command wrappers tested; TS `tauriIO.ts` and dialogs not tested |
| UI | Host screen (temporary: toolbar, view tabs, recovery banner) | Partial (placeholder). Status banner lists what works and what does not (info.test.ts) |
| UI | Data pane (tables, columns, measures, search, refresh buttons) | Done-tested (jsdom) |
| UI | Import dialog (all six sources) | Partial: form logic tested (importForm); the dialog itself has no automated test and was not exercised in the real app |
| UI | Data view: virtualized grid, column types, sort | Done-tested (jsdom, 100,000-row fake engine). Single-column sort, read-only; no column resize. Decimal numbers use the default General format (format.test.ts); dates still show DuckDB text, not the Power BI locale format |
| UI | Model view: table cards, drag-to-create relationship, edit panel | Done-tested (jsdom drag events). Cards sit in an automatic grid: no moving, zoom or hiding columns |
| UI | Report view | Not started (shows a visible Not yet implemented message) |
| UI | Ribbon bound to command ids | Not started |
| UI | Classic shell | Not started |
| UI | Modern shell | Not started |
| UI | Per-shell layout persistence | Not started |
| UI | Start screen (Phase 6; layout from Desktop 2.158, see MASTER_PLAN.md). Cloud items shown disabled and marked Deferred | Not started |
| UI | Cloud items on the start screen: OneLake catalog, Sign in, Shared with me | Deferred (no service connectivity; shown disabled) |
| UI | Options > Preview features check of Classic/Modern switches in the real Desktop app | Done (checked by the owner in Desktop 2.158; recorded in research/ui-modes.md). Research item, no code |
