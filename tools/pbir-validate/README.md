# PBIR schemas

The published JSON schemas of the PBIR report format (github.com/microsoft/json-schemas, MIT license) are kept in
`tests/pbir-schemas`. `app/src/core/report/pbirSchema.test.ts` builds a report with every visual type, filter,
formatting object, bookmark and page type through the app's own commands and validates every file against them (and
checks that each formatting object and property is one the schemas list for the visual type), so a regression in what
BIForge writes fails `npm test`.

Refresh when Microsoft publishes newer versions:

```
cd tools/pbir-validate
node fetch-schemas.mjs     # needs the GitHub CLI (gh)
```

then update the version list in the test. A schema pass says the files are well formed; it does not say Power BI Desktop
draws the same picture.
