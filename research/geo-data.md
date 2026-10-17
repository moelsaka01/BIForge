# Map data (original notes)

Maps use no online tiles and no Microsoft or other map service.

## Source and license
- Natural Earth (naturalearthdata.com), 110m admin 0 countries, 110m admin 1 states and provinces (only the 51 US features are in that file), 50m populated places (simple).
- License: public domain. The Natural Earth terms of use say that no permission is needed and crediting is unnecessary; BIForge credits it anyway (`app/src/assets/geo/NATURAL-EARTH.md`). Checked 2026-10-17.
- Raw downloads stay in `research/_raw/ne/` (gitignored). `tools/geo/build.mjs <folder>` makes `app/src/assets/geo/world.json` (about 280 KB): outlines rounded to two decimals, the names a report can use for each region (NAME, NAME_LONG, ABBREV, FORMAL_EN, NAME_ALT, BRK_NAME), ISO codes, a centroid (largest ring, shoelace formula), and 1251 places as `[name, lon, lat, country code, population, ascii name]`.
- ADMIN and SOVEREIGNT are not used as names: for overseas territories they hold the sovereign's name ("France" for New Caledonia) and would shadow the real country.

## How a label is placed (`app/src/core/report/geo.ts`)
- Lower case, accents and punctuation removed, one space between words.
- Order: country (name, long name, ISO 2 or 3 letter code, a short alias list), then US state (name, or a two letter postal code written in capitals), then city. Cities with one name resolve to the most populous (Portland is Oregon).
- A filled map accepts countries and US states only; a bubble map also accepts cities, or takes longitude and latitude values.
- A label the data does not know is not drawn and not guessed. It is listed under the visual ("N locations not drawn: ..."). The 50m places file has 1251 places, so small towns (for example Utrecht) are reported, not placed.

## Honest limits
- The map style setting (road, aerial, canvas, gray) is drawn as flat sea and land colors; there is no imagery.
- Not done: heat map, zoom buttons, lasso, regions below US state or country level, shape map, route lines.
- Role names of the visuals (Category, Series, X for longitude, Y for latitude, Size; filled map Category and Y for color saturation) follow the common PBIR names but are not checked against files written by Desktop.
