// Our own helper: turns the report theme schema bundle of an installed Power BI Desktop into
// app/src/core/format/capabilities.json, the machine-readable list of formatting objects ("cards") and properties
// per visual type that the schema-driven Format pane reads.
//
//   node tools/re/format-capabilities.mjs <desktop.reportThemeSchema.json.min.js> [out.json]
//
// Only facts about the file format are kept: object names, property names, value kinds, allowed values and numeric
// ranges. Display titles and descriptions of the schema (Microsoft's interface strings) are deliberately dropped;
// the app writes its own labels. Run again when a new Desktop version adds properties.
import fs from "node:fs";
import vm from "node:vm";
import { createHash } from "node:crypto";

const [, , input, output = "app/src/core/format/capabilities.json"] = process.argv;
if (!input) throw new Error("usage: node format-capabilities.mjs <desktop.reportThemeSchema.json.min.js> [out.json]");
const src = fs.readFileSync(input, "utf8");
const a = src.indexOf("JSON.parse('") + 11;
const b = src.lastIndexOf("')") + 1;
const schema = JSON.parse(vm.runInNewContext(src.slice(a, b)));
const defs = schema.definitions;
const deref = (n) => (n && n.$ref ? deref(defs[n.$ref.split("/").pop()]) : n);
const refName = (n) => (n && n.$ref ? n.$ref.split("/").pop() : null);

function merge(n) {
  // collects `properties` through $ref and allOf
  if (!n) return {};
  if (n.$ref) return merge(deref(n));
  let p = { ...(n.properties || {}) };
  for (const s of n.allOf || []) p = { ...p, ...merge(s) };
  return p;
}

/** A compact description of one property: ["b"], ["n", min, max, int], ["s"], ["c"], ["f", min, max], ["e", [values]], ["x"]. */
function kind(prop) {
  const ref = refName(prop);
  if (ref === "fill" || ref === "colorOrThemeColor" || ref === "themeDataColor") return ["c"];
  if (ref === "fontSize") {
    const d = deref(prop);
    return ["f", d.minimum ?? 8, d.maximum ?? 60];
  }
  const d = deref(prop);
  if (!d) return ["x"];
  const options = d.oneOf ?? d.anyOf;
  if (options && options.length && options.every((o) => "const" in o)) return ["e", options.map((o) => o.const)];
  if (d.enum) return ["e", d.enum];
  switch (d.type) {
    case "boolean":
      return ["b"];
    case "string":
      return ["s"];
    case "number":
    case "integer": {
      const k = ["n"];
      if (d.minimum !== undefined || d.maximum !== undefined || d.type === "integer") k.push(d.minimum ?? null, d.maximum ?? null);
      if (d.type === "integer") k.push(1);
      return k;
    }
    default:
      return ["x"];
  }
}

const cardTable = new Map(); // id -> { prop: kind }
const byHash = new Map();
function cardId(props) {
  const text = JSON.stringify(props);
  const h = createHash("sha1").update(text).digest("hex").slice(0, 8);
  if (!byHash.has(h)) {
    byHash.set(h, h);
    cardTable.set(h, props);
  }
  return h;
}

const visuals = {};
const styleProps = schema.properties.visualStyles.properties;
for (const [vname, node] of Object.entries(styleProps)) {
  const star = merge(node)["*"];
  if (!star) continue;
  const cards = merge(star);
  const out = {};
  for (const [card, def] of Object.entries(cards)) {
    if (card === "*") continue; // the flat union used by theme files, not an object
    const item = def.items ?? def;
    const props = {};
    for (const [pn, pd] of Object.entries(merge(item))) {
      if (pn.startsWith("$")) continue;
      props[pn] = kind(pd);
    }
    out[card] = cardId(props);
  }
  visuals[vname] = out;
}

// The container objects (title, border, tooltip, ...) are defined a second time, by name only, in the published PBIR schema,
// and that list is the one a report file is validated against: a name the theme schema has but the PBIR schema lacks
// would make the file invalid, so the pane only offers the names of the PBIR schema for these objects.
const pbirSchemaFile = new URL("../../tests/pbir-schemas/fabric/item/report/definition/visualConfiguration/2.8.0/schema-embedded.json", import.meta.url);
const pbir = JSON.parse(fs.readFileSync(pbirSchemaFile, "utf8"));
const container = {};
for (const [object, def] of Object.entries(pbir.definitions.VisualContainerFormattingObjects.properties)) {
  const ref = def.items?.properties?.properties?.$ref;
  if (!ref) continue;
  const props = pbir.definitions[ref.split("/").pop()]?.properties;
  if (props) container[object] = Object.keys(props);
}

const cards = Object.fromEntries([...cardTable.entries()].sort(([x], [y]) => x.localeCompare(y)));
const result = {
  source: "Report theme schema of Power BI Desktop (object and property names, value kinds, allowed values, ranges)",
  kinds: "b boolean; n number [min,max,integer]; s text; c color; f font size [min,max]; e one of [values]; x structured value (kept as written, not edited)",
  cards,
  visuals,
  container,
};
fs.writeFileSync(output, JSON.stringify(result));
const size = fs.statSync(output).size;
console.log(`${Object.keys(visuals).length} visual styles, ${Object.keys(cards).length} distinct cards, ${(size / 1024).toFixed(0)} KB -> ${output}`);
