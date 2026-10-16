# M evaluation in BIForge: what is implemented, what is assumed

Original notes. Sources: Microsoft's public M language reference and function documentation, the Power Query UI's behavior as seen in Power BI Desktop 2.158 (steps it writes), and the tests of this repository. **Nothing here has been recorded from Desktop's mashup engine yet** (unlike DAX, which has a recorder); every item marked *assumed* is a reading to check. `tests/m/README.md` lists queries to run in Desktop and the results BIForge gives.

## Design in one paragraph
A table is a chain of SQL common table expressions over DuckDB. Every CTE carries a hidden `__ord` column that holds the row order, because M tables are ordered and SQL tables are not: sources number their rows (`row_number() OVER ()` over a file scan, which DuckDB keeps in file order), filters keep `__ord`, sorts and groups renumber it, joins and appends derive it from the inputs. The final statement orders by `__ord`. Scalar expressions inside `each` are evaluated *symbolically*: `[Amount] * 2` evaluates to a SQL fragment, constants fold in Rust. Schemas come from `DESCRIBE` of each step, so a step that cannot run fails on that step (the Applied Steps list shows which). Anything that cannot fold reports "not supported"; there is no row-by-row fallback.

## Sources
| M | SQL |
|---|---|
| `Csv.Document(File.Contents(p), [Delimiter, QuoteStyle])` | `read_csv(..., header=false, all_varchar=true, nullstr=<never>)`, columns renamed `Column1..N`. Every field is text, an empty field is `""` (as in Power Query); typing is a later step. `Columns=` and `Encoding=` are ignored (UTF-8 only). |
| `Excel.Workbook(File.Contents(p), useHeaders, ...)` + `{[Item=..., Kind="Sheet"]}[Data]` | the sheet is read by the existing Excel reader into a temporary table. Only worksheets (no tables or named ranges). |
| `Parquet.Document`, `Json.Document` + `Table.FromRecords` | `read_parquet`, `read_json_auto` (JSON only as an array of objects). |
| `Folder.Files(path)` | one row per file, Power Query's column names; `Content` holds the path (`Csv.Document` accepts it). Attributes is always null. |
| `Odbc.Query("Driver={SQLite3 ODBC Driver};Database=...", "SELECT * FROM \"t\"")` | SQLite table. No other ODBC. |
| `Web.Contents`, `Sql.Database`, `PostgreSQL.Database`, `OData.Feed` | **not supported** (clear error). Tables imported from these keep their original import source path for refresh. |

## Table functions
Folded: `PromoteHeaders` (reads the first row; duplicate names get `.1`, `.2`), `DemoteHeaders`, `SelectColumns`, `RemoveColumns`, `ReorderColumns`, `RenameColumns`, `DuplicateColumn`, `TransformColumnTypes`, `TransformColumns`, `SelectRows`, `Sort`, `FirstN`, `LastN`, `Skip`/`RemoveFirstN`, `RemoveLastN`, `Range`, `RemoveRows`, `Distinct`, `ReplaceValue`, `SplitColumn`, `AddColumn`, `AddIndexColumn`, `Group`, `Pivot`, `Unpivot`, `UnpivotOtherColumns`, `FillDown`, `FillUp`, `Combine`, `NestedJoin` + `ExpandTableColumn`, `Join`, `Buffer`, `#table`, `FromRows`, plus `ColumnNames`, `RowCount`, `Column`, `IsEmpty` (these run a small query and return values).
Not supported: `Transpose`, `CombineColumns`, `ExpandRecordColumn`, `ExpandListColumn`, `Profile`, `TransformColumnNames`, error handling functions (`RemoveRowsWithErrors`, `ReplaceErrorValues`: there are no cell-level errors; a failed conversion fails the step), `GroupKind.Local`, nested tables in `Table.Group` (`each _`), `FirstN`/`Skip` with a condition, `Table.Distinct` with a comparer.

## Readings that are *assumed* (check against Desktop)
1. **Comparison with null.** `=` and `<>` are null-safe (`null = null` is true, `null <> 5` is true). `<`, `>`, `<=`, `>=` with a null operand give null, and a row whose filter is null is dropped. Not verified that M's relational operators return null (rather than false).
2. **Type changes are strict.** `Int64.Type` on text parses a number and rounds (7.6 → 8, half away from zero); an unparseable value fails the step. Empty text becomes null for number, date, time, boolean. Number text may contain thousands separators (commas are removed, en-US only); dates are tried with a fixed list of en-US formats (`yyyy-mm-dd`, `m/d/yyyy`, `m/d/yy`, `d-MMM-yyyy`, `MMM d, yyyy`, ...). Date and datetime to text give `m/d/yyyy` and `m/d/yyyy h:mm:ss AM`. Booleans parse through DuckDB (`true/false`, also `yes/no`, `1/0`).
3. **`Number.Round`** rounds half to even by default (`RoundingMode.ToEven`) as the documentation says; `RoundingMode.AwayFromZero` is supported, other modes are not.
4. **Sorting.** Ordinal text comparison (uppercase before lowercase, as DuckDB's binary collation); nulls first when ascending, last when descending; stable.
5. **Group.** Groups keep first-appearance order. `List.Count` counts rows including nulls; `List.Count(List.Distinct(x))` counts distinct non-null values (M counts null as a distinct value: not matched). A sum of an empty group is null.
6. **Pivot.** A combination without rows is null for every aggregation (assumed: M does not call the aggregator for an empty group). Without an aggregation function, duplicates are *not* an error (`any_value`).
7. **Unpivot** drops rows whose value is null (assumed).
8. **Merge.** Null keys match each other (Power Query's merge behavior as documented for Table.Join); output order is the first table's order with unmatched second-table rows last. `RightAnti` is not supported. Column name clashes in `Table.Join` are an error; `ExpandTableColumn` refuses a new name that exists.
9. **`Table.DuplicateColumn`** appends the copy at the end (assumed; the UI shows it next to the source).
10. **`Text.Trim`** removes ASCII whitespace only (RE2 `\s`), not every Unicode space. `Text.Contains` etc. are case-sensitive unless `Comparer.OrdinalIgnoreCase`.
11. **Split by delimiter** ignores the quote style; `SplitTextByEachDelimiter` and character-transition splitters are not supported.
12. **Number/date literals.** M numbers are doubles; integers are written as SQL integers so they stay whole. `/` always divides as doubles.
13. Row order of `Folder.Files` is by full path, case-insensitive (Power Query's order is the folder enumeration order).

## What the editor writes
Step names and M text follow what Power Query writes for the same action (`Changed Type`, `Filtered Rows`, `Removed Columns`, `Grouped Rows`, ...; names stay unique with a numeric suffix). Rebuilding a query after a step edit rewrites the `let` text in canonical form (comments between steps are not kept); an edit of the formula bar or the Advanced Editor keeps the text as typed.
