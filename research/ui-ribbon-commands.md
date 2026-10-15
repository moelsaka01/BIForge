# Desktop UI structure, ribbon and command inventory (build 2.158.1304.0)

Status: group 1 findings. Names below are identifiers/keys, not Microsoft display text.

## 1. How the UI is built
- `PBIDesktop.exe` is a thin .NET Framework launcher (~170 types: command-line parsing, startup telemetry). It does not contain the UI.
- The main shell is the managed assembly `Microsoft.PowerBI.Client.Windows.dll` (~3,600 classes). It hosts WebView2 browsers and exposes .NET objects to JavaScript as "host services" (class names `*HostService`, each registered under a JS-side service name, e.g. ribbon settings, ribbon search, feature switches).
- The report/data/model views and the main ribbon are **JavaScript bundles** under `bin/WebView2Resources/minerva/scripts/` (about 2,400 files; large minified bundles such as `desktop.min.js` at ~18 MB, plus per-view bundles for data explore, model view, DAX query view and TMDL view). So the main ribbon definition is data inside JS, not .NET.
- The **Power Query editor** is separate: its ribbon is an HTML control driven from .NET. The .NET side owns command state (enabled/checked) and execution; the page asks by command name (JS-exported operations: get ribbon state, get labels, get command state(s), execute command, invalidate).
- User settings are a typed bag (`PowerBIUserSettings`) with string/bool settings by key.

**Implication for BIForge:** a command registry with per-command {id, label, enabled-state, execute} plus a separate declarative layout (tabs → groups → controls) matches how the original separates behavior from presentation. Our shells will differ only in that layout, as required.

## 2. Ribbon mode switch (Classic vs Modern question)
- Verified: one persisted user setting, key `PreferredRibbonMode`, string, default `Multiline`. The other layout type is `SingleLine`. A JS settings service reads it at start, writes it on change, and the host pushes changes back. The ribbon renders each tab either as a single-line control list or as multi-line groups. A chevron control at the ribbon's right edge (keytip id `Ribbon_ModeChevron_Keytip`) toggles between the two.
- So the verified switch is **ribbon layout: multi-line (full, default) vs single-line (compact)**.
- NOT verified: that this build has a broader "Modern UI" mode. `FluentUIOn` / "TryNewRibbon" strings exist but belong to the web-service UI settings, not the desktop host. Treat Classic/Modern in BIForge as our own product concept mapped onto ribbon layout mode plus panel/chrome styling. **Open question:** which UI does "Modern" refer to? A screenshot or the setting name would settle it.
- Other layout-ish settings in the same bag: always-dock-sidebar, show-backstage-as-initial-view, show-data-in-pane-switcher, format-pane-expand-subcategories.

## 3. Report-view ribbon tabs (from 225 `Ribbon_*` resource-key ids)
Main tabs: Home, Insert, Modeling, View, Optimize, Help, External Tools.
Contextual tabs: Format (visual/shape), Table tools, Column tools, Measure tools, Visual data/drill.
Control groups seen as ids: Arrange (align, bring forward, send backward, group), Data (get-data menu and sources), Drill (drill down/up, drillthrough, expand next level, switch to next level), Search (command search box), Sensitivity, Visuals gallery, peripheral/additional controls. Keytips (Alt-key sequences) exist for every tab and many commands.

## 4. Report-view command inventory (tooltip ids → command concepts)
- **Clipboard/edit:** Cut, Copy, Paste, FormatPainter, Undo, Redo.
- **Data:** GetData menu with sources: Excel, Text/CSV, SQL Server, Web, OData, Analysis Services, Blank query, Dataflows, Dataverse, Power BI semantic models/datasets, datahub by item type, template apps, recent sources, sample data; EnterData; Refresh; Queries_Edit (Transform data); Publish.
- **Insert:** NewVisual, InsertMoreVisuals, InsertVisualFromFile, Textbox, Button, Shape, Image, NewPage, BlankPage, DuplicatePage, QnA, SmartNarratives, KeyDrivers, DecompositionTree, FindAnomalies, Forecast, Sparklines, RdlVisual (paginated), PowerApps, PowerAutomate, VisualAppSource.
- **Modeling:** NewMeasure, NewQuickMeasure, NewColumn, NewTable, NewCalculationGroup, NewVisualCalculation, NewWhatIfParameter, ManageRelationships, ManageRoles, ViewAsRoles, SortByColumn, DataGroups (new/edit), ColumnName/TableName/HomeTable/DataFormat (currency, percent, comma, decimal places)/ColumnDataType, EnableModeling, LinguisticSchema, QnaLanguage, Sensitivity.
- **View:** PageView, DesktopLayout, MobileLayout, ShowGridlines, SnapToGrid, LockObjects, themes (browse, customize current, online gallery), panes: Filters, Bookmarks, Selection, SyncSlicers, Data, Format, PerformanceAnalyzer, AssistedCreation, Sidebar.
- **Drill:** DrillDown, DrillUp, Drillthrough, ExpandNextLevel, SwitchToNextLevel, ApplyDrillingTo.
- **Format (contextual):** Align, BringForward, SendBackward, font/size/bold/italic/underline/colors, shape fill/outline, width/height, word wrap, alt text, reset to default.
- **Help:** Documentation, Support, Community, Blog, Samples, TrainingVideos, GuidedLearning, About, SubmitAnIdea, ConsultingServices, PartnerShowcase.
- **Other:** command search, Copilot entry point, OneDrive/SharePoint share items.
The full raw id list is kept locally in `research/_raw/ribbon_keys.txt` (not committed).

Scope note for BIForge: items tied to Microsoft cloud services (datahub, Dataverse, Publish, Copilot, Power Apps/Automate, sensitivity, share, store) are out of scope for v1.

## 5. Power Query editor ribbon
- A single enum of **700 ribbon command ids**: 614 buttons, 47 groups, 19 tabs, 8 checks, 6 categories, 3 split buttons, 1 toggle, plus quick-access toolbar and file menu.
- Tabs by id: file menu, view, transform, add-column (insert), tools, and type-specific contextual tabs for List, Record, Binary, Cube, Text, Number, Date/Time, Duration, Logical.
- Group ids show the feature areas: reduce rows/columns, sort, combine, append/merge queries, replace values, convert/transform per primitive type, structured-column ops, parameters, data sources, query dependency, layout, data preview with profiling controls, advanced, script transforms, session/step diagnostics, AI insights.
- A command alias table maps a command name to a UI command plus state commands (checked/toggle state). Two optional mode flags (AI insights, load-to-destination) are gated by debug-mode status.
- Raw enum names are kept locally in `research/_raw/ilspy/editor_ribbon_commands.txt`.

## 6. Gaps and next steps
- Keyboard shortcut table not yet extracted (keytips exist; global hotkeys not located).
- The exact tab → group → control tree for the report ribbon is inside `desktop.min.js`; extract it by structured search when we build our declarative layout.
- Dialog inventory (Options, Manage relationships, Model view panes) not started.
- Resolve the Classic/Modern mapping with the user (section 2).
