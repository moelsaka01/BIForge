# BIForge – project rules for Claude

BIForge: open-source Windows desktop app recreating Power BI Desktop-style workflows (Classic and Modern shells) under original branding. License Apache-2.0.

Follow docs/MASTER_PLAN.md; work one phase per session.

## Scope (changed 2026-10-16)
Target: every feature of Power BI Desktop 2.158 except cloud features. docs/INVENTORY.md is the definition of "everything"; every inventory item has a status in docs/COVERAGE.md.
Excluded entirely (no UI, no disabled buttons, no menu entries; listed only under "Excluded (cloud)" in COVERAGE.md): sign in / accounts, Publish, Share, OneLake catalog, Dataverse, Fabric / SQL databases in Fabric, datahub, Shared with me, Copilot and "Prep data for AI", sensitivity labels, Power BI service features, cloud-only connectors, external semantic models from the service.
Library rule: prefer a mature library (Apache-2.0/MIT/BSD/ISC/Zlib/Unicode-3.0/0BSD/Unlicense only; check and record the license) over custom code when it gives the same result: tiberius (SQL Server, M source Sql.Database), odbc-api, DuckDB extensions, reqwest + quick-xml (Web, REST, OData, XML), calamine, ECharts (maps with Natural Earth boundaries, no online tiles), Monaco, WebView2 printing via Tauri, tauri-driver/WebDriver or Playwright for real-window UI tests.
Never intercept system keys (Print Screen, Win+key, Alt+Tab, ...).

## Online track (added 2026-10-17)
BIForge's own sharing system (Publish & Share, viewing mode, `biforge://` links) is in scope and is separate from the excluded Microsoft cloud. Binding rules and phases O0 to O8 are in docs/ONLINE_PLAN.md: desktop-only viewers, zero cost and no payment card ever, no BIForge-operated servers, no Docker, Apache-2.0 and permissive dependencies only, additive code, RLS only on the backend method, secrets only in Windows Credential Manager. Online items are tracked in docs/COVERAGE.md. When a step needs the owner (a free provider registration or login), give click-by-click steps and continue with other work.

## Fixed decisions (ask the user before changing any)
- Stack: Tauri 2 (Windows), React + TypeScript (Vite), Fluent UI React v9, Monaco (DAX/M editors), Apache ECharts, Rust core, DuckDB, Apache Arrow. No Polars, no SQLite metadata store.
- DAX: custom parser + semantic engine in Rust. Compile measures to DuckDB SQL where semantics allow; filter context, context transition and blank semantics handled in the engine; hybrid evaluator where SQL cannot express behavior.
- M: reuse Microsoft's open-source M parser only if license-compatible (must be checked and recorded); own evaluator folding steps to DuckDB SQL.
- Native project format: text folder format mirroring PBIP/TMDL. PBIP/TMDL import/export first-class; PBIX import read-only, later.
- Classic and Modern are two UI shells over ONE document store and ONE engine. Shells differ only in layout, ribbon arrangement, panel positions, styling. All commands go through the shared command registry; no business logic in shell components. Per-shell layout is stored separately from the document.
- Original name, logo, icons only (Fluent UI open icons allowed).

## Reverse-engineering rules (github.com/morluto/rea)
- Use RE only to document behavior, formats, UI structure, command inventories, shortcuts, DAX/M semantics. Write findings as original notes in `research/`.
- NEVER commit decompiled/disassembled Microsoft source, Microsoft binaries, extracted icons/images/fonts/string resources, or Microsoft report/theme files. Raw output goes in `research/_raw/` (gitignored).
- Implementation code is written fresh from notes.
- Ask the user before running rea against Power BI Desktop.

## Honesty rules
- Never present a mock, stub or hardcoded result as a working feature. Unfinished features are visibly marked in the UI and listed in docs.
- A feature is done only with a passing automated test.
- Keep `docs/COVERAGE.md` (Not started / Partial / Done-tested) and `docs/PROGRESS.md` updated every session. Report failures.

## Git rules
- Conventional commits, commit after each working milestone. Push at least at end of each day and before a session ends. Update PROGRESS and COVERAGE before pushing.
- Never commit secrets or large data files.

## Process safety
Never kill processes you did not start. Stop only your own process, by the exact PID captured when you started it. Never stop by name (no `Stop-Process -Name node`, `taskkill /IM`), because the user may have unrelated processes running.

## Ask first
Large toolchain installs; running rea against Power BI; any fixed decision found unworkable.

## Repo structure
```
app/                 React UI + Tauri shell
  shells/classic/    Classic shell (layout only)
  shells/modern/     Modern shell (layout only)
  core/              shared command registry, state, document store client
crates/engine        DuckDB integration, import
crates/dax           DAX parser + semantic engine
crates/m             M parser/evaluator
crates/model         semantic model + project format (TMDL-like)
crates/publish       online track: package (signed, encrypted), adapters, targets, audit, deep links
tests/               conformance suites; tests/dax = expected-result cases
research/            original notes; research/_raw/ is gitignored
docs/                COVERAGE.md, ARCHITECTURE.md, PROGRESS.md
.github/workflows/   ci.yml (Windows build + tests)
```

## Commands
Verified (from repo root, with cargo on PATH): `cargo test --workspace`; in `app/`: `npm install`, `npm run build`, `npm test`, `npx tauri dev` (opens the window).
RE tooling: dotnet SDK 9 at `C:\Program Files\dotnet`; ilspycmd 9.1.0.7988 in ~/.dotnet/tools; rea via `npx rea-agents`. Power BI Desktop is read in place from its WindowsApps folder (see research/README.md). Keep raw output in research/_raw/ and search it with rg.
Environment note: on this machine `cargo`/`rustc` live in `~/.cargo/bin` and may not be on the bash PATH (`export PATH="$HOME/.cargo/bin:$PATH"`).
