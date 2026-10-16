# Start screen and report-authoring window: structure notes (Power BI Desktop 2.158)

Source: the owner's screenshots of the running app (kept locally in `research/_raw/reference-screens/`, never committed) and the earlier notes in `ui-modes.md` and `ui-ribbon-commands.md`. These notes describe structure and behavior in my own words. No Microsoft images, icons, fonts or strings are copied; BIForge uses Fluent UI open icons and its own wording.

## Window frame
- Title bar (dark, about 26 px at 100% scale): save, undo (disabled with nothing to undo), redo, then the document name with its saved state and a drop-down; a wide search box in the middle that finds ribbon commands; on the right settings, a light/dark switch with a drop-down, a sign-in entry with an avatar, and the window buttons. The bar is also the drag handle.
- Under it, the ribbon (tab strip plus body), then a left strip of view buttons, the view, and a status bar.
- Left strip, top to bottom: Report, Table, Model, DAX query, TMDL (the last two carry a small text caption). The current view has an accent bar on its left edge.
- Status bar: left, where you are (`Page 1 of 1`, or `Table: <name> (<n> rows)` in the Table view); right, zoom: minus, slider, plus, percentage, fit-to-page button (Report and Model views).

## Start screen and File backstage
- The same page is used twice. With nothing open it is the start screen; with a document open the File tab shows it as a backstage with a round back arrow at the top and extra items (Save, Save as, Share, Get data, Import, Export, Publish).
- Left navigation: Home and Open at the top; Sign in, Options and settings, About at the bottom, separated by a rule. The current item has an accent bar.
- Home content: a collapsible heading, then big square cards (a blank report and common data sources); a collapsible Recommended section with cards in a carousel (previous / next arrows at the right); two pill tabs, Recent (selected, dark) and Shared with me; at the right of that row a keyword filter and a Filter drop-down; the list below.
- Cloud features are present but cannot work offline; BIForge shows them disabled and marked Deferred.

## Ribbon
- Tab strip: File, Home, Insert, Modeling, Design, View, Optimize, Help; the contextual tabs Format and Data / Drill appear to the right (in green) only while a visual is selected, Table tools while a table is selected in the Table view. A chevron at the far right collapses the ribbon. Share is at the right end of the strip.
- Body (multi-line mode): groups separated by thin vertical rules, group name centered under each group. Large buttons are an icon over a one- or two-line label; runs of small buttons stack three high (Cut, Copy, Format painter). Home groups: Clipboard, Data, Queries, Insert, Calculations, Sensitivity, Share. The Model view's Home adds Relationships, Parameters, Security and Q&A; the Table view's Table tools tab adds Structure (a table-name box) and Calendars.
- Format (contextual) groups: Interactions (Edit interactions, with an "apply drill down filters to" box), Arrange (Bring forward, Send backward, Selection, Align, Group).
- Hover tips are short sentences ("Connect to data from multiple sources.").

## Panes in the Report view
- Order from left to right: canvas, Filters, Visualizations, Data. Each open pane has its title large at the top-left and a » arrow at the top-right; Filters also has an eye icon. Collapsed, a pane becomes a narrow rail with a « arrow and the title written vertically; all three rails can be collapsed at once, leaving the canvas the full width.
- Filters: sections "Filters on this visual / this page / all pages", each card showing the field and its current condition ("is (All)"), and a dashed "Add data fields here" drop zone. A search box on top.
- Visualizations: a "Build visual" label with three tab icons (build, format, analytics), a grid of visual-type icons (six per row), then the field wells (X-axis, Y-axis, ...), each with a drop zone and chips that have a drop-down and a remove button.
- Data: search box, then tables as a tree; each field has a checkbox, numeric fields a sigma; a table with a mark shows it is a calculated or marked table.
- The canvas shows the page with a thin frame on a light background, with a visual's toolbar above its top-right corner. The page tab strip is at the bottom with a plus button; the page name is at the bottom left of the status bar.
- Model view: tables as cards on a grey canvas, relationship lines between them, a "Properties" rail at the right of the canvas, and the Data pane with Tables / Model tabs; "All tables" layout tab at the bottom.
- Table view: a formula strip (cancel / confirm buttons and a long box) above a column-header row with a filter arrow on each header; the Data pane lists tables.

## How BIForge maps this
- Same vocabulary, own implementation: ribbons are data (`core/shell/ribbon.ts`), shells differ only in layout (`shells/classic`, `shells/modern`), every control dispatches a registered command, unfinished controls are drawn disabled with the reason.
- Not copied or not implemented: the Optimize tab, Copilot, Dataverse, OneLake, the visual-type gallery's icons (BIForge keeps its own glyph buttons), the Analytics tab of the Visualizations pane, the eye icon on Filters, the Properties pane and the formula strip of the Table view.
