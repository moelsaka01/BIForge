# Report files: how BIForge stores a report (PBIR), and what is ours

Sources: Microsoft's public JSON schemas for the report format (github.com/microsoft/json-schemas, folder
fabric/item/report/definition: visualContainer 2.13.0, visualConfiguration 2.8.0, semanticQuery 1.4.0,
filterConfiguration 1.3.0, page 2.1.0, bookmark 2.1.0, bookmarksMetadata 1.0.0, pagesMetadata 1.1.0, report 3.3.0,
formattingObjectDefinitions 1.5.0), read 2026-10-16, plus the public documentation noted in `pbip-tmdl-format.md`.
No binary was analysed for this note. The schema files are not copied into the repository; `tools/pbir-validate`
fetches them when it is run.

## What BIForge writes (all validated)
`pages/<id>/page.json`, `pages/<id>/visuals/<id>/visual.json`, `bookmarks/*.bookmark.json`, `bookmarks/bookmarks.json`,
`pages/pages.json`, `report.json`, `version.json`, and custom themes under `StaticResources/RegisteredResources`.
`tools/pbir-validate` checks the files of a report that uses every visual type, filter type, formatting path, a
bookmark, a drillthrough page, a tooltip page and a theme: **32 of 32 files valid** against the schemas above (this found
two real defects before commit: the sort direction is the text "Ascending"/"Descending" in a visual, not a number as in a
query sort clause, and a new project's base theme lacked its version object). Valid against the schema is not the same as
"Power BI Desktop opens it and draws the same picture": opening BIForge reports in Desktop has not been tried.

## Shapes BIForge relies on (from the schemas)
- A visual is `{ name, position {x,y,z,width,height,tabOrder}, visual { visualType, query { queryState { <role> { projections [ { field, queryRef, nativeQueryRef, displayName } ] } }, sortDefinition }, objects, visualContainerObjects, drillFilterOtherVisuals }, filterConfig, isHidden }`.
  Container formatting (title, background, border, drop shadow, tooltip) is in `visualContainerObjects`, chart formatting in `objects`.
- A field is a query expression: `Column`, `Measure` or `Aggregation { Expression: Column, Function }` over `SourceRef { Entity }`. Aggregate functions: 0 sum, 1 average, 2 distinct count, 3 min, 4 max, 5 count of non-blank, 6 median, 7 standard deviation, 8 variance. Comparison kinds: 0 equal, 1 greater, 2 greater or equal, 3 less, 4 less or equal. Time units: 0 day, 1 week, 2 month, 3 year.
- A filter container is `{ name, field, type (Categorical | Range | Advanced | TopN | ...), filter { Version 2, From [ {Name, Entity} ], Where [ { Condition } ] } }`. Conditions: `In`, `Not`, `Comparison`, `Between`, `Contains`, `StartsWith`, `And`, `Or`. A Top N filter holds a subquery (`Top`, `OrderBy` with direction 1 ascending / 2 descending). Literals are text: `'text'`, `12L`, `2.5D`, `true`, `datetime'2024-01-31T00:00:00'`, `null`.
- Conditional formatting is an expression inside a property: `FillRule { Input, FillRule { linearGradient2 | linearGradient3 { min, mid, max, nullColoringStrategy } } }` or `Conditional { Cases [ { Condition, Value } ], DefaultValue }`.
- Page interactions are `page.visualInteractions [ { source, target, type: Default | DataFilter | HighlightFilter | NoFilter } ]`. A drillthrough page has `type: Drillthrough` and a `pageBinding` with parameters bound to page filters; a tooltip page has `type: Tooltip`.
- A bookmark is `{ displayName, name, options {suppressData, suppressDisplay, suppressActiveSection}, explorationState { activeSection, sections { <page> { visualContainers { <visual> { singleVisual { display { mode: hidden } } } } } } } }`.
- A custom theme is a file in `StaticResources/RegisteredResources`, listed in `report.json` under `resourcePackages` (type `RegisteredResources`, item type `CustomTheme`) and named in `themeCollection.customTheme`.

## What is BIForge's own (Desktop ignores or does not understand it)
- Annotations on the report or a page/visual (the schemas allow annotations and Desktop ignores them):
  - `biforge.relativeDate.<name>`: a relative-date filter ("in the last 7 days") on a holder. I did not copy the date-arithmetic form of the schema, which I could not verify.
  - `biforge.bookmark.<id>`: the data state of a bookmark (filters and slicer selections of the page, drill position, selected data points). The bookmark file keeps the page and the hidden visuals in the schema's own form, so Desktop shows those; it does not know the filter and drill state.
- Slicer styles are stored as `objects.data[0].properties.mode` with our values (Basic, Dropdown, Tile, Between, Before, After, Relative); series colors use `selector.metadata` with the series label. These follow the object/selector shape but the property values are ours.
- Data bars (`values.dataBars`) and display units (`displayUnits`, `decimalPlaces`) are our property names.

## Open items
- Open a BIForge report in Power BI Desktop and compare the picture (the schema check cannot say).
- Field parameters, calculation groups, visual calculations, mobile layouts, groups of visuals, buttons/shapes/images/text boxes: not read or written; files that contain them are kept as they are (unknown files are preserved, unknown properties of known files stay).
- Filters BIForge cannot interpret (for example an exists-condition) are kept in the file and never applied; the Filters pane does not show them.
