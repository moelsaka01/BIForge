# DAX parser: grammar surface and function catalog (build 2.158.1304.0)

Source: managed static analysis of the client-side DAX parser assembly (~315 types, no native code) with rea and a type lister. Only identifiers, enum members and string-literal tokens were read. No decompiled code is reproduced. Semantics (evaluation) live in the native engine and are NOT covered here; see `dax-harness-design.md`.

## 1. What the parser is for
A client-side parser used by the editor and model tooling: it tokenizes, builds an expression tree, validates function calls against function metadata, supports cursor/completion activity, can add missing parentheses, convert to the engine's form, or anonymize a formula. It is not the evaluator.

Parse entry modes: single **Expression**, a **Query**, or **MultipleQueries**; plus a "mask expression type" flag. Final-parse options: legacy default, add missing parens, convert to engine, anonymize.

## 2. Lexical structure (token types)
- **Comments:** multi-line, single-line (`//`) and SQL-style (`--`).
- **Operators and punctuation:** `<>`, `<=`, `>=`, `&&`, `||`, `==` (strict equality), `=`, `<`, `>`, `^`, `+`, `-`, `*`, `/`, `&` (concatenate), parentheses, curly braces (table constructors / `IN` lists), list separator, dot. Arithmetic operator set: add, subtract, multiply, divide, power. Comparison set: equal, strict equal, greater, less, greater-or-equal, less-or-equal, not-equal. Logical: and, or.
- **Literals:** string (double quotes), number, date-time literal (own token type), TRUE/FALSE keywords.
- **Identifiers:** plain identifier; quoted identifier (single quotes, for table names); bracketed identifier (square brackets, for columns/measures). Whitespace is a token.
- **Keywords (query layer):** `VAR`, `RETURN`, `NOT`, `EVALUATE`, `DEFINE`, `MEASURE`, `ORDER BY`, `ASC`, `DESC`, `START AT`, `IN`, plus the `DATATABLE` form, and `EVALUATEANDLOG` as a distinct function-like token. The reserved-variable-name check exists (error "variable name reserved").
- Constant data types known to the parser: string and number. Formula/value types: unknown, int64, double, string, boolean, date, currency, any, numeric, none, scalar, column reference, table reference, table.

## 3. Syntax errors the parser distinguishes (16 codes)
Can't separate formula name and expression; function call on non-function; grammatical error; incomplete number; invalid order-by / partition-by / match-by parameter; invalid identifier; invalid name character; invalid tuple location; invalid parameter; missing parameters; too many parameters; right argument of `IN` not a table; unrecognized identifier; variable name reserved. Useful as a checklist for our own diagnostics and test cases.

## 4. Function metadata model (how functions are described)
- **Categories (18):** Date and time, Information, Logical, Math and trig, Statistical, Text, Filter, Parent-child, Deprecated, Engineering, Financial, Extension, Query, System, User-defined, Window (plus None).
- **Function roles (flags):** scalar, builds-table, calendar-table, group-by-table, value-table, rollup family (rollup, add-is-subtotal, is-subtotal, group), evaluate-and-log, order-by, partition-by, match-by, plus masks for "returns table", "rollup functions" and "available by default".
- **Parameter roles:** the type of argument (scalar, table value, table ref, qualified column ref, simple column ref, new column, enum value, string, data table, order-by, partition-by, match-by, rollup variants) combined with *context actions*: add to result, extract table/column, scopes (immediate, constructed, related, simple-related, global, home), merge table/columns into row context, replace/delete row context, earlier/earliest context, save as group-by context, filter expression, use column-selection contexts from parent. These describe, per function parameter, how filter and row context flow. This is the closest thing in the parser to a semantics table and is a good checklist for our engine's context model.
- **DirectQuery pushability:** nothing / measures / calculated columns / everything (per function).
- Function data is supplied **from the engine at runtime** (types for function and parameter data "from engine"), using the engine's discovery rowsets for functions and keywords. So the *complete* catalog (names, categories, parameter lists, optionality, repeatable groups) is obtained from the live engine, not from the parser binary.

## 5. Functions the parser knows by name (static list, ~210 identifiers)
These are names the parser special-cases or validates itself (the rest arrive from engine metadata). Grouped for convenience:
- **Filter/context:** CALCULATE, CALCULATETABLE, ALL, ALLEXCEPT, ALLNOBLANKROW, ALLSELECTED, ALLCROSSFILTERED, REMOVEFILTERS, KEEPFILTERS, FILTER, FILTERS, VALUES, DISTINCT, CROSSFILTER, USERELATIONSHIP, TREATAS, RELATED, RELATEDTABLE, EARLIER, EARLIEST, SELECTEDVALUE, HASONEVALUE, HASONEFILTER, ISFILTERED, ISCROSSFILTERED, ISINSCOPE, ISEMPTY, ISSUBTOTAL, LOOKUPVALUE, NONVISUAL, SUBSTITUTEWITHINDEX, CURRENTGROUP.
- **Table construction:** ADDCOLUMNS, ADDMISSINGITEMS, SELECTCOLUMNS, SUMMARIZE, SUMMARIZECOLUMNS, GROUPBY, ROLLUP, ROLLUPGROUP, ROLLUPADDISSUBTOTAL, ROLLUPISSUBTOTAL, GENERATE, GENERATEALL, GENERATESERIES, CROSSJOIN, UNION, INTERSECT, EXCEPT, NATURALINNERJOIN, NATURALLEFTOUTERJOIN, FULLOUTERJOIN, ROW, DATATABLE, CALENDAR, CALENDARAUTO, TOPN, TOPNSKIP, SAMPLE, TOCSV, TOJSON, COLUMNSTATISTICS, EXTERNALMEASURE.
- **Window functions:** INDEX, OFFSET, WINDOW, RANK, ROWNUMBER, ORDERBY, PARTITIONBY, MATCHBY (with ORIGIN, DENSE, SKIP, FIRST, LAST, REL, ABS options).
- **Aggregation and iterators:** SUM, SUMX, AVERAGE(A), AVERAGEX, COUNT(A/X/BLANK/ROWS), COUNTAX, DISTINCTCOUNT(NOBLANK), APPROXIMATEDISTINCTCOUNT, MIN/MAX(A/X), MEDIAN(X), PRODUCT(X), GEOMEAN(X), PERCENTILE.EXC/INC (X), STDEV.P/S (X), VAR.P/S (X), RANK.EQ, RANKX, CONCATENATEX, LINEST/LINESTX, XIRR, XNPV.
- **Time intelligence:** DATEADD, DATEDIFF, DATESBETWEEN, DATESINPERIOD, DATESMTD/QTD/YTD, TOTALMTD/QTD/YTD, FIRSTDATE, LASTDATE, FIRSTNONBLANK(VALUE), LASTNONBLANK(VALUE), STARTOF/ENDOF month/quarter/year, OPENING/CLOSINGBALANCE month/quarter/year, NEXT/PREVIOUS day/month/quarter/year, PARALLELPERIOD, SAMEPERIODLASTYEAR, YEARFRAC, WEEKDAY, WEEKNUM, plus date-part names.
- **Misc:** CONTAINS, CONVERT, EVALUATEANDLOG, NAMEOF, PATH, PATHITEM, PATHITEMREVERSE.
Raw list is local only (`research/_raw/dax_allcaps_strings.txt`).

## 6. Getting the authoritative catalog (plan)
Use the black-box harness (`dax-harness-design.md`): against the live local engine run the engine's function-discovery queries (the discovery rowset for functions, and the DAX `INFO` functions family if available in this build) and record the output as `tests/dax/catalog/functions.json` (our own recorded data: names, category, parameter names/types/optional/repeatable, return type). Same for the keyword list. This also gives us the exact parameter-role information that the parser consumes.

## 7. Implications for BIForge
- Our `crates/dax` lexer should cover the token set in section 2, including `--` and `//` comments, date-time literals, `==`, and `&&`/`||`.
- Parser needs three entry modes (expression, query, multi-query) and the query keywords; `DEFINE` with `MEASURE`/`VAR`/(`FUNCTION`/`COLUMN`/`TABLE` to be confirmed from the catalog or docs).
- Model function metadata as {category, role flags, parameters[{role, optional, repeatable}]} loaded from a recorded catalog file, so parsing/validation is data-driven like the original.
- Reuse the 16 error kinds as the initial diagnostic taxonomy.
- Open: exact precedence/associativity table, how `IN`/table constructors and `NOT` bind, date-literal syntax. Resolve from Microsoft's public DAX reference and by harness queries.
