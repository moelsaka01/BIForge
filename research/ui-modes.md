# Classic vs Modern: switches that control the authoring UI (build 2.158.1304.0)

Definitions (from the project owner):
- **Modern**: the current default UI with newer authoring features on (on-object interaction, the new Format pane, current styling, single-line ribbon if that is the default, newer card and slicer visuals).
- **Classic**: the older equivalents Power BI still offers (multi-line ribbon, no on-object, older visual defaults). Note: 2.158 offers no legacy Format pane, so Classic also uses the modern Format pane (see "Verified in the running app" below).

Method: searched the feature-switch description table and the main desktop bundle on disk with rg, plus the user-settings class. Switch names are identifiers; descriptions below are paraphrased.

## Two kinds of controls
1. **User settings** (persisted per user, typed bag on the .NET side): changed from the UI.
2. **Feature switches** (boolean bag read by the JS UI as `featureSwitches.<name>`; 378 distinct names are read by the main bundle). A subset is computed in the .NET host from settings, policy and sign-in state (names prefixed `PBI_` in the host); the rest arrive from service-side flighting that I could not inspect statically. For on-object and the modern Format pane I found no host-side mapping, so **how a user flips them (Options > Preview features or flighting) is unverified** and needs a check in the running app.

## Mapping table
| Area | Modern | Classic | Control | Confidence |
| --- | --- | --- | --- | --- |
| Ribbon layout | single-line (compact) | multi-line (default in this build) | user setting `PreferredRibbonMode` = `SingleLine` / `Multiline` | verified |
| Ribbon extras | design ribbon (theme controls moved into it), formatting ribbon, optimize tab, ribbon search bar | absent | feature switches `designRibbon`, `formattingRibbon`, `optimizeTabRibbon`, `ribbonSearchBar` | verified names, defaults unknown |
| On-object interaction | on-object editing and formatting of visuals, on-object pane customization dialog | no on-object; pane-based editing | feature switch `onObject` (also `onObjectMobileAuthoring`); user flag for the first-use customization dialog; per-visual capability `supportsOnObjectFormatting` / `isOnObjectSupported` | verified names |
| Pane settings (docking, switcher entries) | pane settings service is registered only when `onObject` is on: always-dock-sidebar and per-pane "show in pane switcher" options (data, format, suggested visuals, bookmarks, selection, performance, sync slicers, build, quick measures, anomalies, page visuals, copilot) | not registered | feature switch `onObject` + user settings (`AlwaysDockSidebar`, `Show*InPaneSwitcher`) | verified |
| Format pane | modern components in the Format pane; theme formatting inside the pane; matrix header formatting options | legacy Format pane | feature switches `useModernFormatPane`, `themeFormatPane`, `matrixFreezeRowHeadersFormatPane`; user setting `FormatPaneExpandSubcategories` is shared | verified names |
| Explore canvas | modern Angular explore canvas | legacy canvas | feature switch `useModernExploreCanvas` | verified name |
| Styling | new light pane colors; Fluent 2 base theme as the default report theme; new zoom control; theme dialog and base-theme update | older colors and default theme | `paneColorRefresh`, `newVisualDefaults2026`, `newZoomControl`, `themeDialog`, `baseThemeUpdate`, `themeVersion2Support` | verified names |
| Visuals | newer slicer styling (border and icon colors, slider colors), button/tile formatting, visual border width, visual calculations authoring | older formatting sets | `slicerBorderAndIconColors`, `slicerSliderColors`, `buttonTileFormatting`, `visualBorderWidth`, `visualCalculationsAuthoring` | verified names |
| Report definition version | PBIR container/config schema versions (visual container 2.5 to 2.9, config 2.3) gated by switches | older report format | `pbir_visualContainer_2_*`, `pbir_visualConfiguration_2_3_0` | verified names |
| Other user settings | app theme (including dark mode), backstage as initial view, new filter pane preferred (`IsNewFilterPanePreferred`) | - | user settings | verified names |

## What this means for BIForge
- Treat each row as a *shell capability flag*, stored in per-shell layout config (not in the document): `ribbonMode`, `onObject`, `powerQueryEditor: "new" | "current"`, `paneStyling`, `visualDefaults: "fluent2" | "classic"`.
- Modern shell: single-line ribbon default, on-object overlay editing, modern Format pane, new Power Query editor, Fluent 2 default theme. Classic shell: multi-line ribbon, the same modern Format pane without on-object, current Power Query editor, classic default theme. Both read the same document and call the same commands.
- Visual defaults ("older card/slicer visuals") are **document-affecting** (they change rendered output), so they must be a *report theme/visual-default setting in the document*, not a shell-only choice. Needs a decision.

## Open items
- Done for Options > Preview features (see the verified table below). The View tab and ribbon switches are still unchecked.
- Identify the legacy card and slicer visuals (older vs "new" card) – not located yet.
- Defaults per switch (what a fresh install gets) are not derivable from static analysis.

## Verified in the running app (Power BI Desktop 2.158, Options > Preview features)
Checked by the project owner on the reference machine. This resolves the "how does a user flip it" question for these switches.

| Feature | In 2.158 | Default | BIForge Modern | BIForge Classic |
| --- | --- | --- | --- | --- |
| On-object interaction | Preview feature toggle | Off | On | Off |
| Format pane | No toggle: the modern Format pane is the only one offered | Modern | Modern Format pane | Modern Format pane (same pane; Classic edits through it without on-object) |
| New Power Query experience | Preview feature toggle | Off | New Power Query editor | Current Power Query editor |
| Enhanced DAX Time Intelligence | Preview feature toggle | Off | Not a shell difference: match the default (off) behavior first; the enhanced behavior is a later item | same |
| Save as PBIP with TMDL model and PBIR report | Enabled on the reference machine | (machine setting) | Native format for both shells | same |

Consequences:
- The earlier assumption that Classic uses a legacy Format pane is dropped: both shells use the modern Format pane. Classic differs by having on-object off (pane-based editing) and the multi-line ribbon.
- The Power Query editor has two UIs; Modern gets the new one, Classic the current one (Phase 5 follow-up, see docs/COVERAGE.md).
- DAX time intelligence follows the classic (default) semantics. The enhanced variant is recorded in COVERAGE.md as a later item.
