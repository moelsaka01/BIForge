# Style presets (General tab > Style preset)

Original notes written from reading Power BI Desktop 2.158's front-end bundle in place (raw output stays in `research/_raw/`, gitignored).
No Microsoft code or text is copied; the settings below are described, and the implementation is `app/src/core/report/stylePresets.ts`.

## What the bundle shows

* A visual stores its choice as `stylePreset.name` (an empty or missing name is the "Base" preset, no change).
* The list a visual offers is: Base, the built-in presets of the visual type (only tables and matrices have any), and the custom presets the report theme defines.
* **Theme presets.** In the theme file's `visualStyles`, the key `*` is the default style of a visual type; any other key is a *custom style preset* for that visual type (the theme schema calls it "Custom style preset for visual"). `visualStyles.*` (every visual type) can hold them too. A preset is an object of formatting objects, like the default style. Order of precedence: the visual's own setting, the preset, the theme's default style, the built-in default.
* **Built-in presets of `tableEx` (Table) and `pivotTable` (Matrix).** Stored names and the labels shown:

| stored `name` | label |
| --- | --- |
| `Default` | Default (the default of both visuals) |
| `None` | None |
| `Minimal` | Minimal |
| `BoldHeader` | Bold header |
| `AlternatingRows` | Alternating rows (deprecated; listed only when a file uses it) |
| `AlternatingRowsNew` | Alternating rows |
| `ContrastAlternatingRows` | Contrast alternating rows |
| `FlashyRows` | Flashy rows |
| `BoldHeaderFlashyRows` | Bold header flashy rows |
| `Sparse` | Sparse |
| `Condensed` | Condensed |

(The old Table and Matrix visuals list the same presets without `Default` and the newer alternating rows.) The Fluent base theme sets `stylePreset.name` to `None` for tables and matrices.

## What each built-in preset sets

Each preset is a function of the theme's palette: background (bg), foreground (fg) and table accent. `mix(a, share, b)` is color `a` laid over color `b` with that share of `a`.

| preset | grid lines | row padding | header | values (rows 1, 2, ...) | totals |
| --- | --- | --- | --- | --- | --- |
| Minimal | horizontal in mix(fg, .12, bg), no vertical | 3 | fg on bg | fg on bg, no stripes | fg on bg |
| Bold header | as Minimal | 3 | bg on fg | as Minimal | fg on bg |
| Alternating rows | as Minimal | 3 | bg on fg | fg on bg; second rows fg on mix(fg, .08, bg) | bg on fg |
| Contrast alternating rows | as Minimal | 3 | bg on fg | bg on mix(fg, .75, bg); second rows fg on mix(fg, .25, bg) | bg on fg |
| Flashy rows | none | 3 | fg on bg | fg on mix(accent, .4, bg); second rows mix(accent, .8, bg) | fg on bg |
| Bold header flashy rows | none | 3 | bg on fg | as Flashy rows | bg on fg |
| Sparse | none, line color mix(fg, .2, bg) | 6 | bg on fg | fg on bg | bg on fg |
| Condensed | horizontal and vertical in mix(fg, .2, bg) | 0 | bg on fg | fg on bg | bg on fg |

The outline color of the whole table (accent, or fg / bg for the flashy presets) is also set by Desktop; BIForge draws no table outline and ignores it.
`Default` (grid color mix(fg, .12, bg), row padding 1, stripes mix(fg, .08, bg)) and `None` are BIForge's own look: it applies no preset values for them, so existing reports look the same.

## In BIForge

* `FormatReader` consults the preset between the visual's own setting and the theme's default style, for every setting it reads. That makes theme presets work for every visual and the built-in ones for tables and matrices.
* The Style preset list is built from the visual type and the report's theme (`presetChoices`); a stored name nobody defines stays in the list marked "(not in the theme)" instead of being replaced.
* BIForge's earlier invented presets (Default, Minimal, Boxed on every visual) are gone: Desktop does not know them. A file that stores `Boxed` keeps the name and shows it as "(not in the theme)"; it has no effect.
* Not done: saving the current formatting as a new preset ("Save current formatting as" in Desktop, which writes the preset into the theme), per-preset display names for theme presets, the deprecated Table and Matrix visuals.
