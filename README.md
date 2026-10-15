# BIForge

An open-source Windows desktop application for building data models and interactive reports, with workflows inspired by Power BI Desktop (both a "Classic" and a "Modern" authoring shell), under original branding.

> **Status: early development.** Nothing here is usable yet. See [docs/COVERAGE.md](docs/COVERAGE.md) for the honest, per-feature status and [docs/PROGRESS.md](docs/PROGRESS.md) for the dated log.

## Mission

Provide a transparent, diffable, scriptable alternative for desktop BI authoring: import data, shape it, model it, write DAX measures, and build reports, with a text-based project format that works with Git and can interoperate with PBIP/TMDL.

## Feature goals

Goals, not promises. Status per item lives in `docs/COVERAGE.md`.

- **Data connectivity** – CSV, Excel, JSON, Parquet, folders, ODBC/databases (via DuckDB extensions where possible).
- **Power Query** – M parser, step-based evaluator folding to DuckDB SQL, query editor UI with applied steps.
- **Modeling** – tables, relationships (single/bi-directional), measures, calculated columns, hierarchies, formatting.
- **DAX** – parser, semantic engine, filter context, context transition, blank semantics; compiled to DuckDB SQL where semantics allow, hybrid evaluator otherwise. Monaco-based editor.
- **Reports** – pages, ECharts-based visuals, slicers, filters, cross-highlighting, themes.
- **Interoperability** – PBIP/TMDL import and export (first-class); PBIX read-only import (later).
- **Classic / Modern UI** – two shells over one document store and one engine; shells differ only in layout, ribbon arrangement, panel placement and styling.

## Tech stack

Tauri 2 (Windows) · React + TypeScript (Vite) · Fluent UI React v9 · Monaco · Apache ECharts · Rust core · DuckDB · Apache Arrow.

## Architecture overview

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). In short: `app/` (UI shells + shared `core/` command registry and state) talks via Tauri commands to Rust crates `engine`, `dax`, `m`, `model`. Data returns to the UI as Arrow.

## Build from source

Prerequisites: Rust (stable, MSVC target), Visual Studio Build Tools (C++), Node.js 22+, WebView2 runtime. Then: `cd app && npm install && npx tauri dev` to launch; `cargo test --workspace` and `cd app && npm test` to test.

## Roadmap

| Day | Goal |
| --- | --- |
| 1 | Toolchain, workspace scaffold, blank window, CI green, DuckDB + Arrow smoke path |
| 2 | Import (CSV/Excel), model store, project folder format, Classic shell skeleton |
| 3 | DAX parser + core evaluator with conformance tests, basic visuals |
| 4 | M subset folding, TMDL import/export, Modern shell, packaging, honest coverage report |

The 4-day plan is aggressive; anything not finished will be marked as such in the UI and docs.

## Contributing

Open an issue before large changes. Every feature needs an automated test before it is marked done. Do not contribute material derived from Microsoft binaries, decompiled output, or extracted assets. See [CLAUDE.md](CLAUDE.md) for the project rules.

## License

Apache-2.0. See [LICENSE](LICENSE).

## Disclaimer

BIForge is an independent project. It is not affiliated with, endorsed by, or sponsored by Microsoft. It does not include Microsoft code or assets. "Power BI", "DAX", "Power Query" and related names are trademarks of Microsoft and are used only descriptively for compatibility.
