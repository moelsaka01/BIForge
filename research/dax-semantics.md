# DAX semantics as implemented in BIForge (Phase 3 core)

Original notes. Sources: Microsoft's public DAX reference (operators, data types, blank handling, function pages), public explanations of expanded tables and filter context, and our own reasoning. No Microsoft binaries were analysed for semantics. Items marked **harness** are our best reading and must be confirmed with recorded cases (tests/dax, fixture in tests/dax/fixtures).

## Values
- Types: BLANK, Boolean, Integer (i64), Real (f64), Currency (fixed decimal, value x 10,000), Text, DateTime (days since 1899-12-30, time as the fraction).
- Text comparison and identity ignore case. When loading a column, the first spelling of a value wins for every case variant (storage collation behaviour) (**harness**: trailing spaces).
- `=` treats BLANK as 0, "" or FALSE depending on the other side; `==` matches BLANK only with BLANK. `IN` / CONTAINSROW use the strict form (BLANK IN {0} is FALSE).
- Comparing Text with a number, or Boolean with a number, is an error (type mismatch message as in the reference).
- Arithmetic: BLANK+BLANK=BLANK, BLANK+5=5, 5-BLANK=5, BLANK-5=-5, BLANK*5=BLANK, BLANK/5=BLANK, BLANK/BLANK=BLANK, 5/BLANK=Infinity, 0/BLANK=NaN. Text converts to a number when it parses, else error. TRUE/FALSE count as 1/0.
- Logic: TRUE||BLANK=TRUE, FALSE||BLANK=FALSE, TRUE&&BLANK=FALSE, FALSE&&BLANK=FALSE, BLANK||BLANK=BLANK, BLANK&&BLANK=BLANK (from the public table; **harness**: the last two).
- Result types: Integer op Integer stays Integer except division (Real); overflow becomes Real. Currency with Integer stays Currency; Currency * Real = Currency; Currency / non-Currency = Currency; Currency / Currency = Real (**harness** for the mixed cases). Date +/- number = Date; Date - Date = Date (a duration that displays as a date).
- `^` binds tighter than the unary sign: `-2^2 = -4` (**harness**).
- Default text form: numbers in the General format (15 significant digits); dates as M/D/YYYY plus h:mm:ss AM/PM when there is a time (**harness**).

## Filter context
- A filter is a set of allowed tuples over some columns, or a set of rows of one model table.
- The expanded table of T = T plus every table reachable from T through active many-to-one (and one-to-one, both ways) relationships. A filter applies to T only when all its columns are in T's expanded table; T's rows are tested through the relationship path, and an unmatched key sees the related table's blank row (all values BLANK).
- Table filters (FILTER(T,...), VALUES(T), ALL(T) as a filter argument, a table variable) are filters over all columns of T's expanded table. So `CALCULATE(..., FILTER(ALL(Sales), ...))` replaces the filters on Product, Customer, Date columns; a fact-table filter does not filter the dimension tables (**harness**: `CALCULATE(COUNTROWS(Product), FILTER(Sales, TRUE()))` under a Color filter returns all products).
- A table without lineage (e.g. `{1, 2}`) used as a filter filters nothing.
- Overwrite: a CALCULATE filter removes existing filters on its columns; a filter on several columns keeps its other columns, projected (arbitrarily shaped filters lose their shape). Filter arguments of one CALCULATE are intersected with each other. KEEPFILTERS adds without removing.
- Boolean filter `pred` = FILTER(ALL(columns used at row level), pred), evaluated in the outer filter context; columns must come from one table (several columns of one table allowed). Columns inside aggregations (e.g. `MAX(Sales[Qty])`) are not row-level.
- ALL()/REMOVEFILTERS() remove every filter; ALL(T) removes the filters on T's expanded table (ALL(Sales) also clears Product/Customer filters); ALL(col, ...) the listed columns; ALLEXCEPT(T, cols) the expanded table except cols.
- CALCULATE order: (1) evaluate filter arguments in the original context, (2) context transition, (3) USERELATIONSHIP / CROSSFILTER, (4) ALL / REMOVEFILTERS / ALLEXCEPT, (5) apply filter arguments. So ALL inside an iteration removes the transition filters, and explicit filters override them.

## Relationships
- One side filters the many side through expansion. Many side filters the one side only when the relationship is bidirectional (or CROSSFILTER BOTH), as a semi-join that applies only when the many side is actually filtered; with nothing filtering Sales, a bidirectional dimension keeps its rows without facts.
- A filter never loops back to its origin: a filter on Promotion reaches Sales but is not semi-joined back into Promotion.
- Chains: a dimension filter flows Product -> Sales -> Promotion (bidirectional) and on to tables filtered by Promotion.
- Many-to-many: a semi-join by value in the enabled direction(s).
- USERELATIONSHIP activates a relationship and deactivates the other active relationship between the same two tables. CROSSFILTER: NONE disables, ONEWAY = one side filters many side, BOTH, ONEWAY_LEFTFILTERING / ONEWAY_RIGHTFILTERING = the left / right column's table filters the other.
- Blank row: a table gets a virtual blank row when an *active* many-to-one relationship into it has unmatched many-side keys (including BLANK keys) (**harness**: whether inactive relationships also create it). VALUES(T), ALL(T), VALUES(col), ALL(col) include it; a table reference, DISTINCT and ALLNOBLANKROW do not (**harness** for the plain table reference). It is filtered like any row whose values are all BLANK.

## Row context and context transition
- Iterators push a row context. A column reference outside any row context that contains its table is the "single value cannot be determined" error.
- Context transition (CALCULATE, CALCULATETABLE, RELATEDTABLE, measure references) turns every row context into filters, outermost first. A model-table row becomes a filter on all that table's columns by value, so identical duplicate rows are selected together. A row of a computed table becomes one-value filters on its columns that have lineage.
- Row contexts stay visible inside CALCULATE (`SUMX(Sales, CALCULATE(Sales[Qty] * 2))` works).
- A measure is evaluated as CALCULATE(expression) without the caller's row contexts or variables.
- RELATED follows the active many-to-one path from the innermost row context of a model table (USERELATIONSHIP in effect is honoured). EARLIER(col, n) / EARLIEST read outer row contexts.

## Variables
- `VAR` values are computed lazily, once, in the context where they are defined (filter and row context); an unused failing variable is not an error. Variables can hold tables (with lineage).

## Calculated columns
- Computed after loading, in dependency order (references to other calculated columns directly or through measures). A cycle marks the columns involved as failed with a circular-dependency message; other columns are still computed. A failing column is BLANK and reported.
- Difference from the reference engine: two calculated columns of one table that both use context transition depend on each other there (a circular dependency unless the table has a key); BIForge filters only on the columns computed so far and does not report that cycle.

## SQL compilation (fixed decision)
- SUM, AVERAGE, MIN/MAX (non-text), COUNT of stored columns and COUNTROWS of model tables compile to DuckDB SQL when every filter reaching the table is a value filter on stored columns and no cross-filter semi-join can apply. Relationship paths become LEFT JOINs; text keys use `lower(...)`; BLANK keys `IS NULL`. Everything else is evaluated by the engine over columns loaded from DuckDB. Tests run every measure both ways on the fixture data.

## Open questions for the harness
1. Blank row from inactive relationships; table reference vs VALUES with the blank row.
2. BLANK||BLANK and BLANK&&BLANK; `-2^2`.
3. Currency mixed arithmetic result types; date-to-text default format.
4. Fact-table filter overriding dimension filters (COUNTROWS(Product) case above).
5. Multi-column filters spanning several tables: we apply them only to tables whose expanded table holds every column.

## Phase 3 additions (function tranches)

**Superseded where the section "Recorded from Power BI Desktop" below differs**: the **harness** readings here were checked against Desktop; the changes (time intelligence anchors, DATEADD, balances, blank handling, errors) are listed there.

Sources: Microsoft's public function reference and our own reasoning, as before. Everything marked **harness** is our best reading and is covered by pending cases in tests/dax/cases (to be recorded from Power BI Desktop's local engine once the fixture report exists).

### Marked date tables
- A table marked as a date table has a key date column (`Model::date_tables`; from TMDL `dataCategory: Time` plus the `isKey` column). A CALCULATE filter argument that involves that column replaces **all** filters on the table, not only the filters on the column. This is why `CALCULATE(..., DATESYTD(Date[Date]))` still gives a year to date when a month filter from a visual is in force. Without the mark only the column's own filters are replaced (tested both ways in tranche_time.rs). **harness**: whether ordinary boolean filters on the key column behave the same.

### Time intelligence (default behavior)
- Context dates = values of the date column visible in the filter context. Date-returning functions return values of the whole column (filters ignored) inside a range computed from the context dates, as a table with the column's lineage.
- Anchors (**harness**): DATESMTD/QTD/YTD and STARTOF*/ENDOF* use the last context date (STARTOF* returns the first visible date of that period); PREVIOUS*/NEXT*/PARALLELPERIOD use the first context date (PARALLELPERIOD returns whole periods from the shifted first to the shifted last date); PREVIOUSDAY/NEXTDAY use the first date.
- DATEADD / SAMEPERIODLASTYEAR: each context date is moved by the interval (day clamped to the month end: Feb 29 -> Feb 28) and the result is the set of those dates present in the column. No whole-period alignment (**harness**: Power BI may return a complete month when a complete month is selected).
- OPENINGBALANCE* = value on the day before the first visible date of the period of the last visible date; CLOSINGBALANCE* = value on the last visible date of that period (**harness**).
- TOTALMTD/QTD/YTD = CALCULATE(expression, DATES*(dates), filter); a text literal in the filter position of TOTALYTD and the balance functions is the year end date ("6/30"). FIRSTNONBLANK/LASTNONBLANK evaluate the expression with the column filtered to one value (no row context).
- Fiscal year end ("6/30"): the year starts the day after the year end.

### Other decisions to confirm
- BLANK in numeric / text / date functions counts as 0 / "" / serial 0 (12/30/1899) (cases math.blank.args, date.parts).
- ROUND is half away from zero after normalizing to 15 significant digits (1.005 -> 1.01); INT returns Integer; ROUND of an Integer with digits >= 0 stays Integer; TRUNC of a Number stays Number.
- PRODUCT returns Number; AVERAGEA / MINA / MAXA count text as 0 and booleans as 1/0, skipping BLANK.
- SWITCH compares with `=` (so BLANK matches 0 and ""); comparing text with a number is an error.
- FORMAT: number sections, `0 # , . % E+`, quoted and escaped literals, named formats, date tokens (yyyy MMMM ddd HH h mm ss AM/PM tt); `mm` after `h` is minutes, `M` months. Unknown characters are copied.
- VALUE accepts thousands separators, `$`, `%`, `(n)`, dates and times; empty text is an error, BLANK stays BLANK.
- Sample variance and standard deviation over fewer than two values return BLANK; GEOMEAN over a non-positive value is an error; PERCENTILE.EXC outside 1/(n+1)..n/(n+1) is an error.
- RANKX: ties SKIP (default) or DENSE, BLANK expression values are ignored and a BLANK value ranks BLANK; the value argument defaults to the expression in the current context.
- ALLSELECTED: the "outer" selection is the filter context in force before the innermost SUMMARIZECOLUMNS group-by or context transition (shadow filters). No subtotals / ROLLUP support, hence no ISINSCOPE.
- LOOKUPVALUE ignores the filter context (searches every row of the result column's table) (**harness**).
- TOPN keeps rows tied with the last place; GROUPBY evaluates its expressions over CURRENTGROUP().

## Recorded from Power BI Desktop 2.158.1304.0 (2026-10-16)

308 queries on the fixture model were recorded from Desktop's local engine (tests/dax/cases, tools/dax-record). On first contact, before any engine change, **230 of 307 matched (75%)**. The 77 differences were investigated with ad-hoc probes (tools/dax-record/probe.mjs) and the engine was changed to follow the recorded behavior, so the 308 of 308 now passing is a fit to these recordings, not independent evidence beyond them. The open questions from the sections above are settled as follows.

### Resolved open questions
1. **Blank row**: an *inactive* relationship with orphan keys also gives the one side a virtual blank row (`VALUES('Date')` has 732 rows for a 731-row table). A table reference (`COUNTROWS(Product)`), `DISTINCT` and `DISTINCTCOUNT` do not include it; `VALUES` and `ALL` do. `DISTINCTCOUNT` counts an empty-text value but not the virtual blank row.
2. **BLANK || BLANK and BLANK && BLANK are FALSE** (not BLANK). `-2^2 = -4` confirmed.
3. **Types and text**: Currency arithmetic result types and the date-to-text default format matched. Booleans print as `TRUE` / `FALSE` in text (`TRUE() & "y"` is `TRUEy`); `FORMAT(TRUE(), "")` is `True`, `FORMAT(TRUE(), "0")` is `-1`.
4. **A table filter over a fact table also restricts the dimensions it points to**: `FILTER(Sales, ...)` as a CALCULATE filter leaves only the products referenced by the kept rows (`FILTER(ALL(Sales), TRUE())` gives 8 of 9 products, the unsold one drops out). Row-context transition does not (it filters the table's own columns only). Several filter arguments of one CALCULATE intersect.
5. Multi-column filters spanning several tables: **not tested**, still our reading.
- Marked date table: confirmed (`time.marked*` cases): a filter on the key column replaces all filters on the table.
- LOOKUPVALUE ignores the filter context: confirmed.
- ALLSELECTED (slicer, no outer filter, CALCULATE-only, row context, no arguments, table form): all matched.

### New facts, all implemented
- **Empty text is not BLANK**: Desktop loads an empty CSV field as `""`, distinct from BLANK in grouping (`Product[Color]` has both). The test fixture mirrors this (the engine's own CSV import still produces BLANK; a Phase 5 interop item). Text ordering is culture-aware: accents sort next to their base letter (`Émile` between `Dana` and `Farah`).
- **BLANK in a math function**: the result is BLANK when it would be 0 (`SIN(BLANK())`, `ABS(BLANK())`, `ROUND(BLANK(), 0)`), otherwise f(0) (`COS(BLANK())` = 1, `EXP` = 1, `FACT` = 1, `LN(BLANK())` = -Infinity); LCM keeps its 0. **BLANK in a text function**: BLANK for LEN, LEFT, RIGHT, MID, UPPER, LOWER, TRIM, REPT, SUBSTITUTE, UNICODE; REPLACE treats it as empty text; CONCATENATE of two BLANKs is BLANK. YEAR/MONTH/DAY/HOUR/MINUTE/SECOND of BLANK are BLANK.
- **Errors**: `COUNT` of a True/False column; `APPROXIMATEDISTINCTCOUNT` (DirectQuery only); `MEDIAN` of text, boolean or date columns; `GENERATESERIES` with a step <= 0; `GENERATE` with equal column names on both sides; `NONVISUAL` outside SUMMARIZECOLUMNS; `DATE(y, m, 0)`; `TIME` with an argument outside 0..32767; `FLOOR(x, 0)`; `CEILING`/`FLOOR` of a positive number with a negative significance; `MROUND` with different signs; `NETWORKDAYS` with a weekend string ("0000011"; only codes 1-7 and 11-17); `VALUE("50%")`, `VALUE(TRUE())`, `VALUE("")`; `COMBINEVALUES` needs 3 arguments.
- **Numbers**: `IFERROR`/`ISERROR` treat Infinity and NaN as errors (`IFERROR(1/0, "bad")` is "bad"; plain `1/0` is Infinity). `SWITCH` uses strict equality for BLANK (BLANK matches only BLANK). `BITLSHIFT`/`BITRSHIFT` wrap the count modulo 64. `ISNUMBER` is TRUE for dates; `ISEVEN(3.9)` rounds (TRUE), `ISEVEN(BLANK())` is TRUE. `CEILING`/`FLOOR`/`MROUND` return Integer when result and significance are whole; `CEILING(x, 0)` is 0; `MROUND(5, 0)` is 0; `CEILING(-2.5, -1)` = -3, `FLOOR(-2.5, -1)` = -2; `INT(Currency)` is Currency. `REPT`, `LEFT` etc. round fractional counts (`REPT("x", 2.9)` = "xxx"); `T.*` and `CHISQ.*` round non-integer degrees of freedom (`T.DIST(2, 10.9)` = `T.DIST(2, 11)`), `CONFIDENCE.T` rounds the size.
- **Dates**: `DATE` two-digit years 0..29 -> 2000.., 30..99 -> 1930..1999, 100..1899 literal; fractions round (`DATE(2024.9, 1.9, 1.9)` = 2025-02-02); `EDATE` returns the date without a time and rounds months. `VALUE` returns a Number for dates and times (`VALUE("2024-03-05")` = 45356, `VALUE("12:00")` = 0.5); `VALUE("(5)")` = -5.
- **Statistics**: `VAR.S`/`STDEV.S` over one value are NaN, over none BLANK; `GEOMEAN` has no error for zero or negative values (zero -> 0, negative product -> real root for an odd count, NaN for an even count); `RANKX` ranks a BLANK value like 0; `MEDIANX` over an empty table is BLANK; `CONCATENATEX` over an empty table is BLANK.
- **Tables**: `SUMMARIZE` added columns see only the rows of the source table (`SUMMARIZE(FILTER(Sales, ...), ...)`); columns named by `SELECTCOLUMNS` print as `[Name]` even when they keep their lineage; `ALLCROSSFILTERED(T)` clears T and the tables that filter T (a table that only reaches T through the fact table keeps its filter).
- **Time intelligence** (differs from our first reading): `STARTOF*` = first date of the period of the *first* context date, `ENDOF*` = last date of the period of the *last* context date, both from the whole date column (single day 3/15: month start 3/1, end 3/31); `PREVIOUSDAY`/`PREVIOUS*` anchor on the first context date, `NEXTDAY`/`NEXT*` on the last; `CLOSINGBALANCE*` is the value at `ENDOF*` and `OPENINGBALANCE*` the value the day before the period start of the first date; month shifts keep the end of the month (Jun 30 - 6 months = Dec 31, Jan 31 + 1 month = Feb 29); `DATEADD` / `SAMEPERIODLASTYEAR` return the whole shifted interval when the context dates are a continuous run of the date column, otherwise each date is moved on its own (so Feb 2024 + 1 month is all of March).

### Still open
- Multi-column filters spanning several tables (question 5).
- `FORMAT(TRUE(), "General")` gives `Ge0eral` in Desktop (the format string is parsed as a custom format); not reproduced, no case.
- `IFERROR(VALUE("x"), -1)` is a Number (-1.0) in Desktop because the branches are unified to one type; BIForge returns an Integer.
- Everything the 308 cases do not cover: the recorded fixture is small (241 sales rows) and several areas have one case only.
