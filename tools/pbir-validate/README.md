# PBIR schema check

Validates the report files BIForge writes against Microsoft's public JSON schemas for the PBIR report format
(github.com/microsoft/json-schemas, `fabric/item/report/definition`). The schemas are fetched when you run the
check and are not stored in this repository.

```
cd tools/pbir-validate
npm install ajv@8
node fetch-schemas.mjs                      # needs the GitHub CLI (gh), writes ./schemas (ignored by git)
cd ../../app
PBIR_DUMP=../tools/pbir-validate/dump.json npx vitest run src/core/report/pbirDump.test.ts
cd ../tools/pbir-validate
node validate.mjs dump.json
```

The dump is a report with every visual type, filter type, formatting path, a bookmark, drillthrough and tooltip
pages and a theme. Last run: all files valid against visualContainer 2.13.0, page 2.1.0, bookmark 2.1.0,
bookmarksMetadata 1.0.0, pagesMetadata 1.1.0, report 3.3.0 and versionMetadata 1.0.0 (see docs/PROGRESS.md).
A schema pass says the files are well formed, not that Power BI Desktop renders them the same way.
