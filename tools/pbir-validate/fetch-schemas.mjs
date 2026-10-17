// Fetches Microsoft's public JSON schemas for the PBIR report format (github.com/microsoft/json-schemas, MIT license)
// into tests/pbir-schemas, where they are kept in the repository so that the schema test runs offline.
// Needs the GitHub CLI (gh). Run again when a newer schema version is published, then update the version list in
// app/src/core/report/pbirSchema.test.ts.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
const BASE = "fabric/item/report/definition";
const OUT = join("..", "..", "tests", "pbir-schemas");
const seen = new Set();
function fetchFile(rel) {
  const out = execFileSync("gh", ["api", `repos/microsoft/json-schemas/contents/${rel}`, "--jq", ".content"], { encoding: "utf8", maxBuffer: 50e6 });
  return Buffer.from(out.trim(), "base64").toString("utf8");
}
function get(rel) {
  if (seen.has(rel)) return;
  seen.add(rel);
  const text = fetchFile(rel);
  const dest = join(OUT, rel);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, text);
  for (const m of text.matchAll(/"\$ref"\s*:\s*"([^"#]+)(#[^"]*)?"/g)) {
    const ref = m[1];
    if (ref.startsWith("http")) continue;
    get(posix.normalize(posix.join(posix.dirname(rel), ref)));
  }
}
const roots = [
  "visualContainer/2.13.0/schema.json",
  "visualContainerMobileState/2.8.0/schema.json",
  "page/2.1.0/schema.json",
  "bookmark/2.1.0/schema.json",
  "bookmarksMetadata/1.0.0/schema.json",
  "pagesMetadata/1.1.0/schema.json",
  "report/3.3.0/schema.json",
  "reportExtension/1.0.0/schema.json",
  "versionMetadata/1.0.0/schema.json",
];
for (const r of roots) get(`${BASE}/${r}`);
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "LICENSE"), fetchFile("LICENSE"));
writeFileSync(join(OUT, "README.md"), "These JSON schemas are copied from https://github.com/microsoft/json-schemas (MIT license, see LICENSE). They are the published definition of the PBIR report files; BIForge's saved reports are validated against them by app/src/core/report/pbirSchema.test.ts. Refresh with tools/pbir-validate/fetch-schemas.mjs.\n");
console.log([...seen].join("\n"));
