# M cases to check in Power BI Desktop

`partition_*.m` are the M texts the app writes for the DAX fixture CSVs (checked against BIForge's engine by `crates/engine/tests/it/m_partitions.rs` and against the generator by `app/src/core/model/partitionM.contract.test.ts`).

The cases below are for **checking BIForge's M engine against Desktop** (there is no automatic recorder for M yet). Paste each into a blank query (Advanced Editor), compare the result with the "BIForge gives" column, and record differences in `research/m-semantics.md`. Each one tests a reading that is assumed there. `crates/engine/tests/it/m_queries.rs` (`desktop_check_cases_give_what_the_readme_says`) runs these exact queries, so the right-hand column is what BIForge really returns.

| # | Query | BIForge gives |
|---|---|---|
| 1 | `let S = #table({"a"}, {{1},{null},{3}}), F = Table.SelectRows(S, each [a] > 1) in F` | `3` (null row dropped). Check: does Desktop raise an error or keep the null row? |
| 2 | `let S = #table({"a"}, {{1},{null}}), F = Table.SelectRows(S, each [a] <> 1) in F` | the null row |
| 3 | `let S = #table({"a"}, {{"7.6"},{"-7.5"},{""}}), T = Table.TransformColumnTypes(S, {{"a", Int64.Type}}) in T` | `8`, `-8`, `null` |
| 4 | `let S = #table({"a"}, {{"1,234.5"}}), T = Table.TransformColumnTypes(S, {{"a", type number}}, "en-US") in T` | `1234.5` |
| 5 | `let S = #table({"a"}, {{0.5},{1.5},{2.5},{3.5}}), T = Table.TransformColumns(S, {{"a", each Number.Round(_), type number}}) in T` | `0`, `2`, `2`, `4` (half to even) |
| 6 | `let S = #table({"a"}, {{"B"},{"a"},{null},{"A"}}), T = Table.Sort(S, {{"a", Order.Ascending}}) in T` | `null`, `A`, `B`, `a` |
| 7 | `let S = #table({"k","v"}, {{"x",1},{"y",null}}), T = Table.Group(S, {"k"}, {{"s", each List.Sum([v]), type nullable number}, {"n", each List.Count([v]), Int64.Type}}) in T` | `x,1,1` and `y,null,1` |
| 8 | `let S = #table({"r","y","v"}, {{"n","2023",1},{"s","2024",2}}), P = Table.Pivot(S, {"2023","2024"}, "y", "v", List.Count) in P` | `n,1,null` and `s,null,1` (assumed null; M may give 0) |
| 9 | `let S = #table({"id","a","b"}, {{"x",1,null}}), U = Table.UnpivotOtherColumns(S, {"id"}, "k", "v") in U` | one row `x,a,1` |
| 10 | `let A = #table({"k"}, {{null},{1}}), B = #table({"k","v"}, {{null,"z"}}), N = Table.NestedJoin(A, {"k"}, B, {"k"}, "b", JoinKind.LeftOuter), E = Table.ExpandTableColumn(N, "b", {"v"}) in E` | `null,z` and `1,null` (null keys match). `Table.Join` of these two gives one `k` column (a key column with the same name on both sides appears once, as in the Table.Join documentation) |
| 11 | `let S = #table({"a"}, {{"x"}}), D = Table.DuplicateColumn(S, "a", "b") in D` | columns `a`, `b` (the copy is appended; check whether Desktop puts it elsewhere when the table has more columns) |
| 12 | `let S = #table({"d"}, {{#date(2024,1,2)}}), T = Table.TransformColumnTypes(S, {{"d", type text}}) in T` | `1/2/2024` |
| 13 | `let S = #table({"a"}, {{" x "},{"x"}}), T = Table.TransformColumns(S, {{"a", Text.Trim, type text}}) in T` | `x`, `x` (also check a non-breaking space) |
