# Performance

Measured on the development machine (11th Gen Intel Core i7-1165G7, 4 cores / 8 threads, 15.7 GB RAM, Windows 11), **release** builds,
2026-10-23. Everything here is reproducible:

```bash
node tools/perf-run.mjs 1000000 10000000   # generates the fixtures, runs the benchmark, DELETES the fixtures (they are GBs: never keep them)
# by hand (delete target/perf-fixtures afterwards):
node tools/dax-fixtures/generate-large.mjs 1000000      # writes target/perf-fixtures/1000000 (gitignored)
node tools/dax-fixtures/generate-large.mjs 10000000
cargo run --release -p biforge-engine --features tools --example perf_bench -- target/perf-fixtures/1000000
PERF_EACH=1 cargo run --release -p biforge-engine --features tools --example perf_bench -- target/perf-fixtures/10000000   # per-query times
```

The fixture is the DAX fixture of `tests/dax/fixtures` with a deterministic `Sales` table of 1 M or 10 M rows (same columns, the same
Date / Customer / Product / Promotion dimensions, relationships as in the fixture report). `perf_bench` imports the CSV files into a
DuckDB file, then runs through the same code the app runs (store, `DaxCache`, `Engine::query_with`). The page is eight visuals
(two cards, column, line, donut, a Country x Category bar, a three-column table with three measures, a matrix); the slicer click adds a
Country selection to all of them. Memory is the process working set read from Windows.

What is **not** measured here: the rendering time of the web view (ECharts, the virtualised grid) and the Tauri IPC; the numbers are
the time the Rust side needs to answer.

## Results

### 1 M rows

| | before | after |
| --- | ---: | ---: |
| Import Sales (CSV, 53 MB) | 2.2 s | 2.3 s |
| Table view: page at the start / middle / end | 115 / 222 / 248 ms | 8 / 6 / 5 ms |
| Table view: page in the middle, sorted | 349 ms | 314 ms |
| DAX engine load (first query) | 828 ms, 304 MB | 14 ms (columns load on first use) |
| Page of 8 visuals, first render | 6.9 s | **1.08 s** |
| Page of 8 visuals, second render | 7.3 s | 0.40 s |
| **Slicer click** (8 visuals + slicer list) | 8.8 s | **0.24 s** |
| Heavy query (3 grouping columns, `SUMX`) | 9.7 s | 0.06 s |
| `CALCULATE` with time intelligence (PY, YTD by month) | 0.19 s | 0.17 s |
| Refresh Sales (re-import + reload + one query) | 3.2 s, peak 676 MB | 2.1 s, peak 248 MB |
| Process working set after the page | 330 MB | 232 MB |

### 10 M rows

| | before | after |
| --- | ---: | ---: |
| Import Sales (CSV, 545 MB) | 25.4 s | 21.6 s |
| Table view: page at the start / middle / end | 1.3 / 2.8 / 3.5 s | 15 / 14 / 14 ms |
| Table view: page in the middle, sorted | 7.9 s | 4.3 s |
| DAX engine load (first query) | 15.7 s, 2.9 GB | 14 ms |
| Page of 8 visuals, first render | 110 s | **12.7 s** (the first query reads the four key columns and builds the relationship indexes, about 6 s) |
| Page of 8 visuals, second render | 112 s | 4.2 s |
| **Slicer click** | 186 s | **2.2 s** |
| Heavy query | 144 s | 0.47 s |
| Time intelligence | 0.9 s | 0.8 s |
| Refresh Sales | not measurable (two engines of 3 GB each do not fit in 15 GB with the browser and the editor) | 20.9 s, peak 2.2 GB |
| Process working set after the page | 3.1 GB | 2.0 GB |

Targets of the request: a slicer click on 1 M rows under 1 second (**0.24 s**, met) and 10 M rows usable (a slicer click takes 2.2 s,
the first page 12.7 s, memory 2 GB; met, with the limits below).

## What was slow and what changed

1. **A filter was applied row by row with a hash lookup.** For every group of a visual the engine intersected the filters on the
   fact table by building a key (allocating for text) for each of the 1 M rows. A filter on a dimension column is now decided once per
   dimension row and every fact row is looked up through the resolved relationship path (`filter.rs`, `Graph::follower`). This alone
   took the heavy query from 9.7 s to about 1 s.
2. **`SUMX`, `AVERAGEX`, `MINX`, `MAXX` ran in the interpreter, one row at a time.** A row expression made of columns of the table,
   `RELATED` columns on the one side, numbers, `+ - *`, a division by a constant and `DIVIDE` now compiles to one DuckDB aggregate with
   DAX's BLANK arithmetic (`BLANK + x = x`, `BLANK - x = -x`, `BLANK * x = BLANK`). Other row expressions (conditions, text, variables)
   still run in the engine. `DISTINCTCOUNT` of a stored column compiles too.
3. **One SQL statement per group.** A table with three grouping columns and three measures used to need about 135 statements. When
   every measure of a `SUMMARIZECOLUMNS` is one of the plain aggregates above (also behind a measure reference), the whole visual is one
   `GROUP BY` per fact table (`sql.rs`, `try_batch`). The groups that exist are still decided by the engine; only the measure values come
   from SQL, and combinations without rows are BLANK as before.
4. **Whole tables were loaded into memory on the first query, with every column.** Columns are now read the first time a query uses
   them (`ModelData::load_lazy`, `StoreLoader` with its own connection to the same DuckDB file). Aggregations that run as SQL never read
   their value columns at all. The store's `DaxCache` is cleared before the store is closed so the extra connection cannot keep the file open.
5. **Table view paging** used `ORDER BY rowid LIMIT/OFFSET`, which reads the whole table; it is now a range on `rowid`.

### Checking that nothing changed in the answers

The recorded conformance cases (322) and the holdout cases (160) now run twice: once in the interpreter and once with SQL enabled
(`conformance_cases_with_sql`, `holdout_cases_with_sql`), and the generated report queries do the same
(`generated_report_queries_match_the_fixture_data_through_sql`). Running the recorded cases with SQL found one **existing bug** in the
SQL path that the app has been using since Phase 3: a table filter on a fact table (`CALCULATE(COUNTROWS(Product), FILTER(Sales, TRUE()))`)
also restricts the dimension it points to in Power BI, but the join-based SQL ignored it and returned one group too many. The SQL path now
declines such contexts. `dax_sql.rs` compares 12 aggregations x 12 contexts plus 12 iterator/`DISTINCTCOUNT` expressions and 32 grouped
queries between both paths.

## What is still slow (honest list)

- **The first query after a refresh or a model change** reads the key columns and builds the relationship indexes: 0.5 s at 1 M rows,
  about 6 s at 10 M rows (`rel()` hashes every key).
- **Sorting the Table view by a column** at a deep offset sorts the whole table: 0.3 s at 1 M rows, 4.3 s at 10 M rows (the first page of a
  sort is fast). A cached sort order per column would fix this.
- **Measures that are not plain aggregates** (ratios of two measures, `CALCULATE` with filters, `IF` inside an iterator, `RANKX`, time
  intelligence over many groups) still run in the engine, one group at a time. Time intelligence by month on 10 M rows takes 0.8 s.
- **A refresh of a 10 M row table** takes 21 s, almost all of it the CSV import.
- A 10 M row model needs about 2 GB while it is used: the key columns are held as DAX values (24 bytes per value).
- The rendering side (SVG charts with thousands of points, a table visual with many columns) has not been measured.

## Start-up (front end)

Measured in the built-in browser against `vite preview` of the production build, time from navigation to the first React render of
the start screen, idle machine, nine runs each (the first run is cold, the others use the browser's cache):

| | before | after |
| --- | ---: | ---: |
| First load (cold) | 296 ms | 107 ms |
| Median of the next eight loads | 111 ms | 38 ms |
| Script needed to show the start screen | 2.4 MB (`index-*.js`) | 1.5 MB |

The report canvas with ECharts (`ReportView`, 0.9 MB) and the Power Query editor (83 KB) are separate chunks loaded when a report or the
editor is first shown; the map outlines (`world.json`, 0.3 MB) and Monaco (4 MB, plus its language chunks) were already loaded on use.
The split is `app/src/views/shell/lazyViews.tsx`; the unit tests alias it to `lazyViews.eager.tsx` so components render synchronously.
