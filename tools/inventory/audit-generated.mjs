// Audit of the generated inventory areas: a DAX function or M function counts as Done-tested only when some test file calls it.
//   node tools/inventory/audit-generated.mjs
import fs from "node:fs";
import path from "node:path";
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const root = path.resolve(here, "..", "..");
const walk = (d, out = []) => {
  if (!fs.existsSync(d)) return out;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (["node_modules", "target", "dist", ".git", "_raw"].includes(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
};
const read = (files) => files.map((f) => fs.readFileSync(f, "utf8")).join("\n").toLowerCase();

// DAX: tests in crates/dax/tests, tests/dax (expected-result cases), crates/engine/tests and 
const daxFiles = [...walk(path.join(root, "crates", "dax", "tests")), ...walk(path.join(root, "tests", "dax")), ...walk(path.join(root, "crates", "engine", "tests")), ...walk(path.join(root, "app", "src")).filter((f) => /\.test\.tsx?$/.test(f))];
const dax = read(daxFiles);
const daxMissing = [];
let daxD = 0;
for (const l of fs.readFileSync(path.join(here, "dax-functions.tsv"), "utf8").split("\n").filter(Boolean)) {
  const [c, n, i] = l.split("\t");
  if (i !== "true") continue;
  daxD++;
  if (!dax.includes(n.toLowerCase() + "(") && !dax.includes(n.toLowerCase() + " (") && !dax.includes('"' + n.toLowerCase() + '"')) daxMissing.push(`${c}: ${n}`);
}

// M: tests/m/stdlib/*.json cases, crates/engine/tests/*.rs, app tests
const mFiles = [...walk(path.join(root, "tests", "m")), ...walk(path.join(root, "crates", "engine", "tests")), ...walk(path.join(root, "crates", "m", "tests")), ...walk(path.join(root, "app", "src")).filter((f) => /\.test\.tsx?$/.test(f))];
const m = read(mFiles.filter((f) => !f.endsWith("functions_list.rs")));
// a test may call the function inside an M expression in a JSON case ("List.Sum({1,2})") or in a Rust string
const supported = new Set(JSON.parse(fs.readFileSync(path.join(root, "app/src/core/queries/mFunctions.json"), "utf8")).supported.map((x) => (typeof x === "string" ? x : x.name)));
const mMissing = [];
let mD = 0;
for (const n of fs.readFileSync(path.join(here, "m-names.txt"), "utf8").split("\n").filter(Boolean)) {
  if (!supported.has(n)) continue;
  mD++;
  if (!m.includes(n.toLowerCase())) mMissing.push(n);
}
console.log(`DAX: ${daxD} marked Done-tested, ${daxMissing.length} never called by a test`);
console.log(daxMissing.join("\n"));
console.log(`M: ${mD} marked Done-tested, ${mMissing.length} never named by a test`);
console.log(mMissing.join("\n"));
