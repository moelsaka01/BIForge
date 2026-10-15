# Architecture (planned)

Status: design only; no code exists yet.

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
