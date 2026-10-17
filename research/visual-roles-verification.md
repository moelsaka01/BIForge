# Visual role names and other PBIR items, checked against the Desktop 2.159 bundles (2026-10-17)

Method: `tools/re/data-roles.mjs` reads every `dataRoles:[...]` capability definition in the report bundles (raw output in `research/_raw/data-roles.txt`, ignored by git) and resolves constant references (`name:K.key`) by looking for `key:"Value"` in the same bundle. Only role names are kept: `app/src/core/report/visualRoles.json`, checked against the app's catalog by `visualRoles.test.ts`.

## Role names
| BIForge visual | Result |
| --- | --- |
| bar/column/line/area charts, ribbon | Category, Series, Y, Gradient, **Rows** (small multiples), Tooltips. `Rows` confirmed. |
| line + clustered column | adds `Y2`; also has `Rows` (BIForge does not offer small multiples there yet) |
| pie, donut | Category, Series (Details), Y, Tooltips |
| scatter | Category, Series, X, Y, Size, Gradient, Play, Tooltips |
| decomposition tree | **Analyze, ExplainBy**, Tooltips: guesses confirmed |
| key influencers | **Target, ExplainBy**, Details: guesses confirmed |
| map (bubble) | Category, Series, X (longitude), Y (latitude), Size, Tooltips, PathID, PointOrder: confirmed |
| filled map | Category, Series, X, Y, **Size** (the color saturation well), Tooltips: BIForge used `Y`, **fixed** |
| KPI | Indicator, **TrendLine**, Goal: BIForge used `TrendAxis`, **fixed** (projects migrate on load: `LEGACY_ROLES` in migrate.ts) |
| gauge, treemap, funnel, waterfall, matrix, table, card, multi-row card, slicer | match |

## Other items
- **Group child coordinates: differ.** Desktop keeps a child's position **relative to its parent group** (absolute = child + every ancestor group's x/y; functions that convert both ways exist in the layout service, and the serializer writes the stored position unchanged). Phone layout is not offset. BIForge stores page coordinates. Not fixed yet: a conversion at the project load/save boundary (and the PBIP export) is needed. Tracked in PROGRESS.md.
- **Image storage: differs.** Desktop's `image` object has `sourceType`, `sourceUrl` (a web address), `sourceFile` (an uploaded image, written as a `ResourcePackageItem` expression: package `RegisteredResources`, item name = file name, file under `StaticResources/RegisteredResources/`, listed in report.json `resourcePackages` with type `Image`) and `sourceField`. BIForge writes a data URI into `sourceUrl`. Whether Desktop accepts a data URI there is not known. Fix: store as registered resource.
- **Group display name:** `visualGroup.displayName` confirmed (schema and serializer). **Visual name in the Selection pane:** no property found in the schema or the bundle; stays in the `biforge.displayName` annotation.
- **Only Desktop can settle:** whether a data-URI `sourceUrl` renders; where Desktop stores a renamed visual; bookmark filter state (`explorationState` filters) round trip; the group coordinates by opening a BIForge group file (to confirm the reading above).
