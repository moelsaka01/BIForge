# PBIP, PBIR and TMDL: format notes (from Microsoft's public documentation)

Source: Microsoft Learn pages on Power BI Desktop projects (overview, semantic model folder, report folder) and the TMDL overview, read 2026-10-15. Everything here is paraphrased from the public docs; no binary analysis was needed for this note. Public JSON schemas exist in the microsoft/json-schemas repository (fabric/ item schemas) and should be consulted when implementing validation.

## 1. Project layout
```
<root>/
  <name>.pbip                 pointer file (JSON) to the report folder; optional
  <name>.Report/              report item
  <name>.SemanticModel/       semantic model item
  .gitignore                  created only if absent
```
Default .gitignore content excludes per-user and cache files: `**/.pbi/localSettings.json` and `**/.pbi/cache.abf`.
Several reports/models can share a root; each report can be opened directly via its `definition.pbir`, so a `.pbip` per report is not required. Opening a `.pbip`/`.pbir` opens the report and, if referenced by relative path, the model for editing.
Conversion PBIX <-> PBIP is only possible through the Desktop Save As; there is no documented programmatic converter.

## 2. Semantic model folder
| Path | Required | Purpose |
| --- | --- | --- |
| `definition.pbism` | yes | model item settings; `version` selects formats: 1.0 = TMSL only; 4.0+ = TMSL or TMDL |
| `definition/` | when TMDL | TMDL folder (replaces model.bim) |
| `model.bim` | when TMSL | TMSL database JSON |
| `.platform` | optional | Fabric Git metadata |
| `diagramLayout.json` | optional | model diagram; not externally editable (schema undocumented) |
| `.pbi/localSettings.json` | optional | per user/machine; gitignored |
| `.pbi/editorSettings.json` | optional | shared editor settings |
| `.pbi/cache.abf` | optional | Analysis Services backup holding cached data; gitignored. Without it Desktop opens the model with no data; with it, data loads and the model definition is overwritten by project metadata |
| `.pbi/unappliedChanges.json` | optional | Power Query edits saved with "apply later"; applying overwrites query definitions in the model |
| `DAXQueries/*.dax` + `.pbi/daxQueries.json` | optional | saved DAX query view tabs and tab order |
| `TMDLScripts/*.tmdl` + `.pbi/tmdlscripts.json` | optional | saved TMDL view tabs and tab order |

## 3. Report folder
| Path | Required | Purpose |
| --- | --- | --- |
| `definition.pbir` | yes | report settings + `datasetReference`; `version` 1.0 = PBIR-Legacy only, 4.0+ = Legacy or PBIR |
| `definition/` | when PBIR | enhanced report format (folder of JSON files) |
| `report.json` | when PBIR-Legacy | single-file legacy format; not externally editable |
| `StaticResources/RegisteredResources/` | optional | themes, images, private custom visuals; each file needs an entry in the report definition |
| `CustomVisuals/` | optional | only private custom visuals live here |
| `mobileState.json`, `semanticModelDiagramLayout.json` | optional | undocumented, not externally editable |
| `.pbi/localSettings.json` | optional | per user; gitignored |

`datasetReference` has two forms: `byPath` (relative path, forward slashes, no absolute paths; model opened in full edit mode) and `byConnection` (connection string to a remote model; the model is not editable). PBIR is now the default; opening and saving a legacy report converts it, after a backup.

## 4. PBIR (enhanced report) folder
```
definition/
  version.json                 required – PBIR version
  report.json                  required – report-level filters, formatting, theme collection
  reportExtensions.json        optional – report-level measures
  pages/pages.json             optional – page order, active page
  pages/<pageName>/page.json   required per page
  pages/<pageName>/visuals/<visualName>/visual.json   required per visual
  pages/<pageName>/visuals/<visualName>/mobile.json   optional
  bookmarks/bookmarks.json, bookmarks/<name>.bookmark.json   optional
```
- Every JSON file starts with a `$schema` URL that also fixes that file's schema version.
- Object names (page/visual/bookmark) default to a 20-character id; names must be word characters or hyphens; folder name normally equals the object's `name`. Unrecognized names are treated as private user files and ignored.
- Annotations (name/value pairs) are allowed on report, page and visual and are ignored by Desktop.
- Metadata may embed data values (filter values, slicer selections), so files can contain business data.
- Service limits: 1,000 pages per report, 1,000 visuals per page, 1,000 resource files, 300 MB resource total, 300 MB report total.
- Desktop watches files and offers "apply external changes". Invalid JSON/schema is a blocking error; some problems (such as a bad active page) are auto-fixed.

## 5. General file rules
UTF-8 without BOM for hand-edited files. Desktop writes CRLF line endings (configure Git autocrlf to avoid noisy diffs). Windows 260-character path limit applies; keep root paths short.

## 6. TMDL (semantic model text format)
Folder layout (one level of subfolders, `.tmdl` files):
```
definition/
  database.tmdl  model.tmdl  relationships.tmdl  expressions.tmdl  dataSources.tmdl  functions.tmdl
  tables/<table>.tmdl   cultures/<culture>.tmdl   perspectives/<name>.tmdl   roles/<name>.tmdl
```
A table file contains all its columns, measures, hierarchies and partitions. Objects may be split across files (partial declarations, like partial classes), but the same property cannot be declared twice.

Language rules:
- **Declaration:** `<objectType> <name>`; object types and keywords are camelCase on write, case-insensitive on read. Database and direct children of model (tables, expressions, roles, cultures, perspectives, relationships, data sources, model annotations) are not indented under `model`.
- **Names:** wrap in single quotes if the name contains `.`, `=`, `:`, `'` or whitespace; escape a quote by doubling it. References to other objects use the same quoting; qualified names use dots (e.g. table dot column).
- **Indentation (strict, tab by default):** level 1 declaration, level 2 properties and child objects, level 3 multi-line expressions.
- **Properties:** `name: value` on a single line. Text values may be unquoted; double quotes are needed for leading/trailing whitespace, with `""` as the escape. Booleans may be written `prop: true/false` or as the bare property name meaning true.
- **Default property / expressions:** `=` after the declaration holds the object's default property (measure DAX, calculated column DAX, partition M, named expression, etc.). Multi-line expressions start on the next line, indented one level deeper than the object's properties. Blank lines inside are kept; trailing blank lines are trimmed; common outer indentation is stripped. Three backticks after `=` switch to verbatim mode (indentation set by the closing fence); the serializer uses this automatically when round-tripping needs it.
- **Delimiters:** `=` introduces expressions and defaults; `:` introduces all other property values (including model references).
- **Descriptions:** `///` lines directly above an object (no blank line between), wrapped around 80 characters by the serializer.
- **Child objects:** no explicit collection syntax; children inside the parent scope form its collections in any order.
- **`ref` statements:** `ref table X`, `ref culture X`, `ref role X` in the parent file fix collection order for objects stored in separate files. Missing files are ignored on read; unreferenced files are appended. On write all items are referenced, except single-item collections.
- **Expression-typed properties:** DAX for measure, calculated column/partition, calculation items, format string definitions, table-permission filters, KPI expressions, detail rows; M for partition source and named expressions (also refresh-policy expressions); JSON/XML for linguistic metadata and JSON extended properties.
- **Whitespace:** property values are trimmed; whitespace-only lines become empty lines.

API (for reference only; we do not use it): a TOM class exposes serialize/deserialize for folders, single objects and streams.

## 7. Gaps not covered by the public docs (candidate binary or experiment work)
1. Exact grammar edge cases: annotations (`annotation` lines), extended properties, `changedProperty`, lineage tags, column `isKey`/`summarizeBy` enums, relationship property set and defaults, partition `mode` values, culture/linguistic payload, calculation-group syntax, `PBI_RemovedChildren`. Best source: save a small model from Desktop as PBIP/TMDL and diff, which is behaviour observation of our own data and cheaper than disassembly.
2. `.pbip` file content and schema (pointer file) – public schema repo has it; not yet read.
3. Which TOM property defaults are omitted on write (needed for byte-stable round trips).
4. The TMDL implementation was not found as separate types in `Microsoft.AnalysisServices.Server.Tabular.dll` by class listing; it may live inside another assembly. Not needed unless gap 1 cannot be closed by experiment.

## 8. Implications for BIForge
- Native project format: mirror `definition/` TMDL for the model and a PBIR-like `definition/` JSON tree for the report, plus our own `.biforge` pointer file. Keep `localSettings`-style per-user data and caches outside version control.
- Importer/exporter must preserve unknown properties and annotations to avoid destroying data from other tools.
- Implement TMDL parser/printer in Rust (`crates/model`) with golden round-trip tests built from small hand-written fixtures.
