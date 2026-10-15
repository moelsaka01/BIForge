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
