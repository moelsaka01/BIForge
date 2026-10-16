import Ajv from "ajv";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
const root = "schemas/fabric/item/report/definition";
const byPath = {};
function walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f.endsWith(".json")) {
      const s = JSON.parse(readFileSync(p, "utf8"));
      const key = "https://developer.microsoft.com/json-schemas/" + p.split("\\").join("/").slice("schemas/".length);
      s.$id = key;
      ajv.addSchema(s, key);
    }
  }
}
walk(root);
const id = (p) => `https://developer.microsoft.com/json-schemas/fabric/item/report/definition/${p}`;
const dump = JSON.parse(readFileSync(process.argv[2] ?? "dump.json", "utf8"));
const rules = [
  [/^version\.json$/, "versionMetadata/1.0.0/schema.json"],
  [/^report\.json$/, "report/3.3.0/schema.json"],
  [/^pages\/pages\.json$/, "pagesMetadata/1.1.0/schema.json"],
  [/^pages\/[^/]+\/page\.json$/, "page/2.1.0/schema.json"],
  [/^pages\/[^/]+\/visuals\/[^/]+\/visual\.json$/, "visualContainer/2.13.0/schema.json"],
  [/^bookmarks\/bookmarks\.json$/, "bookmarksMetadata/1.0.0/schema.json"],
  [/^bookmarks\/[^/]+\.bookmark\.json$/, "bookmark/2.1.0/schema.json"],
];
let bad = 0, ok = 0;
for (const [key, doc] of Object.entries(dump.files)) {
  const rule = rules.find(([re]) => re.test(key));
  if (!rule) { console.log("no schema for", key); continue; }
  const validate = ajv.getSchema(id(rule[1]));
  if (!validate) { console.log("schema not loaded", rule[1]); continue; }
  if (validate(doc)) ok++;
  else {
    bad++;
    console.log("INVALID", key);
    for (const e of validate.errors.slice(0, 8)) console.log("   ", e.instancePath, e.message, JSON.stringify(e.params).slice(0, 160));
  }
}
console.log(`validated: ${ok} ok, ${bad} invalid`);
