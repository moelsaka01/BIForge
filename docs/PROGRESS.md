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
