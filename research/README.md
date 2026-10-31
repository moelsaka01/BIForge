# research/

Original notes about the behavior of Power BI Desktop and related formats, written in our own words. See CLAUDE.md for the reverse-engineering rules.

**Raw material deleted (2026-10-31).** `research/_raw/` (decompiled output, front-end bundle extracts, reference screenshots, the DAX fixture report saved by Desktop) was removed from this machine at the end of 2026 so that no Microsoft-owned material is kept. It was gitignored and the git history was checked: it was never committed (see docs/PROGRESS.md, 2026-10-31 legal check). The notes in this folder are our own words and are all that is kept. To regenerate raw material if ever needed (only with the owner's approval, per CLAUDE.md): install Power BI Desktop, run `rea` / `ilspycmd` against its install folder as described below, and write the output to a new `research/_raw/` (still gitignored); rebuild the DAX fixture report by the steps in `tests/dax/fixtures/README.md`; re-download Natural Earth for `tools/geo/build.mjs` (see geo-data.md).

## Method and tooling (as used so far)
- Target: Power BI Desktop 2.158.1304.0 (Microsoft Store/MSIX install), analysed read-only in place; nothing is copied into the repo.
- `rea` (npx rea-agents 6.5.0) CLI: `inspect-managed-artifact`, `inspect-managed-members`. Limitation seen: it cannot admit metadata of very large assemblies (`Microsoft.PowerBI.Client.Windows.dll`, `Microsoft.Mashup.Document.dll`) and reports "CLI metadata could not be admitted".
- `ilspycmd` 9.1.0.7988 (newer versions failed to install with .NET SDK 9.0.319): used only to list types (`-l c|e`) and to decompile single types into `_raw/` for reading small sections (deleted since; see above).
- `tools/re/types.mjs` and `tools/re/scan-strings.mjs`: our own helper scripts to summarise rea output and find which binaries mention a term.
- Token rule: never load whole decompiled output; search with rg and read small slices.

## Notes
- [ui-ribbon-commands.md](ui-ribbon-commands.md) – UI architecture, ribbon tabs, command inventory, ribbon-mode switch.
- [ui-modes.md](ui-modes.md) – Classic vs Modern mapping: user settings and feature switches.
- [pbip-tmdl-format.md](pbip-tmdl-format.md) – PBIP/PBIR/TMDL layout and rules from public docs, plus gaps.
- [dax-parser.md](dax-parser.md) – DAX token set, query keywords, function metadata model and named functions (managed analysis).
- [m-parser-license.md](m-parser-license.md) – license check of Microsoft's open-source M parser and the decision not to embed it.
- [m-semantics.md](m-semantics.md) – what the M engine implements, how it folds to SQL, and the readings that still need a check in Desktop.
- [dax-harness-design.md](dax-harness-design.md) – proposed black-box harness for DAX expected results (design only, not built).
