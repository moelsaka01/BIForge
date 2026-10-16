// Our own helper: lists identifier-like M names (Family.Name) found as UTF-16 strings in an assembly.
import fs from "node:fs";
const b = fs.readFileSync(process.argv[2]).toString("utf16le");
const re = /\b([A-Z][A-Za-z0-9]{1,24}\.[A-Z][A-Za-z0-9]{1,48})\b/g;
const set = new Set(); let m;
while ((m = re.exec(b))) set.add(m[1]);
const fam = process.argv[3] ? new RegExp("^(" + process.argv[3] + ")\.") : null;
console.log([...set].filter(n => !fam || fam.test(n)).sort().join("\n"));
