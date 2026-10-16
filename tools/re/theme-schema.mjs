// Our own helper: prints visual types -> formatting cards -> property names from the theme schema bundle.
import fs from "node:fs";
import vm from "node:vm";
const src = fs.readFileSync(process.argv[2], "utf8");
const a = src.indexOf("JSON.parse('") + 11, b = src.lastIndexOf("')") + 1;
const text = vm.runInNewContext(src.slice(a, b));
const schema = JSON.parse(text);
const defs = schema.definitions;
const out = [];
const names = Object.keys(schema.properties.visualStyles.properties);
function merge(n) { // collect properties of a node through allOf/$ref
  if (!n) return {};
  if (n.$ref) return merge(defs[n.$ref.split("/").pop()]);
  let p = { ...(n.properties || {}) };
  for (const s of n.allOf || []) p = { ...p, ...merge(s) };
  return p;
}
for (const v of names) {
  const node = schema.properties.visualStyles.properties[v];
  const star = merge(node)["*"];
  const cards = merge(star);
  out.push(v + ":");
  for (const [card, cd] of Object.entries(cards)) {
    const inner = merge(cd.items ?? cd);
    out.push("  " + card + ": " + Object.keys(inner).join(", "));
  }
}
fs.writeFileSync(process.argv[3], out.join("\n"));
console.log(names.length + " visual styles");
