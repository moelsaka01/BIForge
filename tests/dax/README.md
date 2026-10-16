# DAX conformance cases

- `fixtures/`: synthetic CSVs for the fixture model, plus build steps for the matching Power BI Desktop report (fixtures/README.md).
- `cases/*.json`: expected-result cases. Cases are written from public documentation and our own reasoning, or recorded from the local engine on our own fixture data (approved by the owner; see research/dax-harness-design.md). Never copied from Microsoft assets.

## Case file format

```json
{ "area": "math", "fixture": "tests/dax/fixtures", "recordedWith": "local Analysis Services of Power BI Desktop 2.158...",
  "cases": [
    {"id": "math.round", "query": "EVALUATE ROW(\"a\", ROUND(2.5, 0))", "source": "recorded",
     "expected": {"columns": ["[a]"], "types": ["real"], "rows": [[3]]}},
    {"id": "math.sqrt.neg", "query": "EVALUATE ROW(\"a\", SQRT(-1))", "source": "recorded", "expected": {"error": "..."}},
    {"id": "math.new", "query": "EVALUATE ...", "source": "pending", "expected": null}
  ] }
```

- Cell values: `null` = BLANK, booleans, numbers, text; dates as `"2024-01-31T00:00:00"` (column type `datetime`); `"NaN"`, `"Infinity"` for real columns. Column types: `int`, `real`, `currency`, `text`, `bool`, `datetime`, `mixed`.
- Rows are compared as a multiset unless the query has `ORDER BY` (or the case sets `"ordered": true`). Numbers match to 1e-9 relative; text is compared exactly; a non-blank cell must have the recorded type (a `real` column accepts whole numbers).
- `"expected": {"error": ...}`: the query must fail (the message is not compared).
- `source`: `recorded` (from Desktop), `hand` (written by hand, never overwritten by the recorder), `pending` (no expected result yet).

## Holdout set

`tests/dax/holdout/` has the same case format. Those cases were written without running them on the engine and recorded afterwards; their pass rate is reported separately (`cargo test -p biforge-engine --test dax_conformance holdout_cases -- --nocapture`; `BIFORGE_HOLDOUT_REPORT_ONLY=1` prints failures without failing the test). Record with `node tools/dax-record/record.mjs --dir holdout`, add with `add-cases.mjs --dir holdout <area> <list.txt>`.

## Running

`cargo test -p biforge-engine --test dax_conformance -- --nocapture` prints `conformance: N/M pass, F fail, S skipped, P pending`. A case where BIForge reports "not implemented" is **skipped**, never counted as a pass; a pending case does not count at all. `BIFORGE_DAX_VERBOSE=1` lists every case and, for pending ones, the BIForge error if there is one; `BIFORGE_DAX_REPORT=<file>` writes the numbers (`pass recorded fail skipped pending`).

## Recording (needs Power BI Desktop and the fixture report)

1. Build the fixture report (fixtures/README.md) and open `DaxFixture.pbip` in Desktop; leave it open.
2. `node tools/dax-record/record.mjs` (options: `--only <regex>`, `--redo`, `--port N`, `--dry`). It reads the pending cases, sends them as read-only `EVALUATE` queries to the local Analysis Services instance (tools/dax-record/query.ps1 loads the ADOMD client library from the installed Desktop package in place; nothing is copied) and writes the answers into the case files. Review the diff before committing.
3. Add cases with `node tools/dax-record/add-cases.mjs <area> <list.txt>` (one `id | query` per line). `record.mjs --format` rewrites the files in the canonical layout.
