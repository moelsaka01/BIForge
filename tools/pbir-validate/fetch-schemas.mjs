import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, posix } from "node:path";
const BASE = "fabric/item/report/definition";
const seen = new Set();
function get(rel) {
  if (seen.has(rel)) return;
  seen.add(rel);
  const out = execFileSync("gh", ["api", `repos/microsoft/json-schemas/contents/${rel}`, "--jq", ".content"], { encoding: "utf8", maxBuffer: 50e6 });
  const text = Buffer.from(out.trim(), "base64").toString("utf8");
  const dest = join("schemas", rel);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, text);
  for (const m of text.matchAll(/"\$ref"\s*:\s*"([^"#]+)(#[^"]*)?"/g)) {
    const ref = m[1];
    if (ref.startsWith("http")) continue;
    get(posix.normalize(posix.join(posix.dirname(rel), ref)));
  }
}
const roots = ["visualContainer/2.13.0/schema.json", "page/2.1.0/schema.json", "bookmark/2.1.0/schema.json", "bookmarksMetadata/1.0.0/schema.json", "pagesMetadata/1.1.0/schema.json", "report/3.3.0/schema.json", "versionMetadata/1.0.0/schema.json"];
for (const r of roots) get(`${BASE}/${r}`);
console.log([...seen].join("\n"));
