# research/

Original notes about the behavior of Power BI Desktop and related formats, written in our own words. Raw tool output lives in `research/_raw/` (gitignored, never committed). See CLAUDE.md for the reverse-engineering rules.

## Method and tooling (as used so far)
- Target: Power BI Desktop 2.158.1304.0 (Microsoft Store/MSIX install), analysed read-only in place; nothing is copied into the repo.
- `rea` (npx rea-agents 6.5.0) CLI: `inspect-managed-artifact`, `inspect-managed-members`. Limitation seen: it cannot admit metadata of very large assemblies (`Microsoft.PowerBI.Client.Windows.dll`, `Microsoft.Mashup.Document.dll`) and reports "CLI metadata could not be admitted".
- `ilspycmd` 9.1.0.7988 (newer versions failed to install with .NET SDK 9.0.319): used only to list types (`-l c|e`) and to decompile single types into `_raw/` for reading small sections.
- `tools/re/types.mjs` and `tools/re/scan-strings.mjs`: our own helper scripts to summarise rea output and find which binaries mention a term.
- Token rule: never load whole decompiled output; search with rg and read small slices.

## Notes
- [ui-ribbon-commands.md](ui-ribbon-commands.md) – UI architecture, ribbon tabs, command inventory, ribbon-mode switch.
- [ui-modes.md](ui-modes.md) – Classic vs Modern mapping: user settings and feature switches.
- [pbip-tmdl-format.md](pbip-tmdl-format.md) – PBIP/PBIR/TMDL layout and rules from public docs, plus gaps.
- [dax-harness-design.md](dax-harness-design.md) – proposed black-box harness for DAX expected results (design only, not built).
