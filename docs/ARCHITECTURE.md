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
