// Usage: node types.mjs <members.json> [regex] [maxLines]
// Prints compact type names (and method counts) from a rea inspect-managed-members JSON dump.
import fs from "node:fs";
const [, , file, rx = ".", max = "60"] = process.argv;
const txt = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
const n = JSON.parse(txt).data.normalized_result;
const re = new RegExp(rx, "i");
const counts = new Map();
for (const m of n.methods ?? []) counts.set(m.declaring_type ?? m.type, (counts.get(m.declaring_type ?? m.type) ?? 0) + 1);
const names = (n.types ?? []).map((t) => t.full_name ?? t.name ?? JSON.stringify(t)).filter((x) => re.test(x));
console.log(`types=${n.types?.length} methods=${n.methods?.length} matched=${names.length}`);
if (n.types?.[0]) console.log("type keys:", Object.keys(n.types[0]).join(","));
if (n.methods?.[0]) console.log("method keys:", Object.keys(n.methods[0]).join(","));
names.slice(0, Number(max)).forEach((x) => console.log(x));
