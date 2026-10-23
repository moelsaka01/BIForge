// Release notes from docs/COVERAGE.md, so they say what the project itself says works and what does not.
//   node tools/release-notes.mjs <version> [public-key-file] > notes.md
// Counts come from the generated inventory table; the lists come from the status column of every table row.
import fs from "node:fs";
import path from "node:path";

const version = process.argv[2] ?? "0.1.0";
const keyFile = process.argv[3];
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const text = fs.readFileSync(path.join(root, "docs/COVERAGE.md"), "utf8").replace(/\r\n/g, "\n");
const lines = text.split("\n");

// the inventory table: | Area | Total | Done | Partial | Not started |
const inv = [];
let total = null;
let inInv = false;
for (const l of lines) {
  if (l.startsWith("## Inventory status")) inInv = true;
  else if (l.startsWith("## ") && inInv) inInv = false;
  if (!inInv || !l.startsWith("|")) continue;
  const c = l.split("|").slice(1, -1).map((x) => x.trim());
  if (c.length === 5 && /^\*?\*?\d/.test(c[1].replace(/\*/g, ""))) {
    const row = { area: c[0].replace(/\*/g, ""), total: +c[1].replace(/\*/g, ""), done: +c[2].replace(/\*/g, ""), partial: +c[3].replace(/\*/g, ""), none: +c[4].replace(/\*/g, "") };
    if (/^Total$/.test(row.area)) total = row;
    else inv.push(row);
  }
}

// feature rows: | Area | Feature | Status | ... (the status text starts with the status word)
const rows = [];
let section = "";
for (const l of lines) {
  if (l.startsWith("## ")) section = l.slice(3);
  if (!l.startsWith("| ") || l.startsWith("| ---") || l.startsWith("| Area") || l.startsWith("| Phase")) continue;
  const c = l.split("|").slice(1, -1).map((x) => x.trim());
  if (c.length < 3 || section.startsWith("Inventory") || section.startsWith("Excluded")) continue;
  const feature = c.length === 3 ? c[1] : c[1];
  const status = c[c.length - 1];
  rows.push({ section, area: c[0], feature: feature.replace(/\s+/g, " ").slice(0, 110), status: status.replace(/\*/g, "") });
}
const kind = (s) => (/^Done-tested/.test(s) ? "done" : /^Partial/.test(s) ? "partial" : /^Not started/.test(s) ? "none" : /^Deferred/.test(s) ? "deferred" : /Not done|Not built|Limits/i.test(s) ? "gap" : "other");
const by = { done: [], partial: [], none: [], deferred: [], gap: [], other: [] };
for (const r of rows) by[kind(r.status)].push(r);
const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);

const out = [];
out.push(`# BIForge ${version}`);
out.push("");
out.push("An open-source (Apache-2.0) Windows desktop app for building data models and reports, with workflows inspired by Power BI Desktop. It is **early software**: read what works and what does not before you rely on it. This text is generated from [docs/COVERAGE.md](https://github.com/moelsaka01/BIForge/blob/main/docs/COVERAGE.md), where every item is marked Done-tested only when an automated test passes.");
out.push("");
const raw = `https://raw.githubusercontent.com/moelsaka01/BIForge/v${version}/docs/media`;
out.push("## See it");
out.push(`[![BIForge demo](${raw}/demo.gif)](https://github.com/moelsaka01/BIForge/releases/download/v${version}/demo.mp4)`);
out.push("");
out.push("[Watch the demo video](https://github.com/moelsaka01/BIForge/releases/download/v" + version + "/demo.mp4)");
out.push("");
out.push("| Report | Model | Power Query |");
out.push("| --- | --- | --- |");
out.push(`| ![Report](${raw}/report-classic.png) | ![Model](${raw}/model-view.png) | ![Power Query](${raw}/power-query.png) |`);
out.push("");
if (version === "0.1.1") {
  out.push("## New in 0.1.1");
  out.push("- DAX: window functions, financial functions (FV, PV, PMT, NPER, RATE, XNPV, XIRR), parent-child PATH functions, TOCSV, COLUMNSTATISTICS, LINEST/LINESTX, ISINSCOPE.");
  out.push("- Performance: aggregates and group-bys compile to DuckDB SQL (1M-row slicer click 0.24 s, 10M rows 2.2 s; see docs/PERFORMANCE.md).");
  out.push("- Modeling: calculated columns and tables, hierarchies, quick measures, what-if and field parameters, calculation groups, roles with View as, auto date/time.");
  out.push("- Power Query: cell-level errors (Keep/Remove/Replace Errors), column statistics, parameters, query groups.");
  out.push("");
  out.push("**Honest limits of this release:** the 18 new DAX cases were recorded from Power BI Desktop 2.159; 10 matched at first and the rest were fixed or documented (XIRR differs in the 8th decimal: a known difference). Window functions over measures with relationships could not be compared with Desktop. The Phase 9/10 features have unit and jsdom UI tests but no real-window end-to-end flow yet. **Code signing is still pending**: the application to the SignPath Foundation has not been decided, so the installers are unsigned.");
  out.push("");
}
out.push("## Why BIForge, and where it goes further");
out.push("BIForge does not have every Power BI Desktop feature (see the numbers below). It goes further in what is free and open:");
out.push("- **Free and open source** (Apache-2.0): no account, no per-viewer license.");
out.push("- **Free sharing that is built in**: folders, GitHub Pages, your own Google Drive / OneDrive / Dropbox, direct connections between two PCs, or a server you host, with row-level security on the server.");
out.push("- **Co-editing and comments with @mentions** over a direct session or your server, with no subscription.");
out.push("- **Scheduled refresh you control**, on a server or on this PC, with history, retries and a label that says where it ran. No gateway.");
out.push("- **Git-friendly projects** (PBIP, TMDL, PBIR text folders) and a command line; PBIP/TMDL import and export.");
out.push("- **Verifiable releases**: signed update files, a signed hash list and build attestations.");
out.push("");
out.push("## Install");
out.push("- **BIForge_" + version + "_x64-setup.exe** (NSIS) or **BIForge_" + version + "_x64_en-US.msi** (WiX). The setup program installs for the current user without administrator rights; the MSI installs for all users and needs administrator rights.");
out.push("- Optional components: the server (`biforge-server.exe`) and the command line (`biforge-cli.exe`). Setup: answer Yes at the end, or run it silently with `/S /TOOLS=1`. MSI: `msiexec /i <file>.msi ADDLOCAL=ALL`. They are also attached to this release on their own.");
out.push("- BIForge checks GitHub Releases for newer versions when it starts (About > switch off) and verifies each update with BIForge's update key before installing it.");
out.push("");
out.push("### Windows warns about this download (SmartScreen, Smart App Control)");
out.push("The installers are **not code-signed yet** (a free signing program for open-source projects has been applied for to the SignPath Foundation; no decision yet). Until then:");
out.push("- **SmartScreen** (\"Windows protected your PC\"): choose *More info*, then *Run anyway*. It improves as more people download the same file.");
out.push("- **Smart App Control** (Windows 11, in *Enforcement* mode) blocks unsigned programs and offers no *Run anyway*. Either turn it off (Settings > Privacy & security > Windows Security > App & browser control > Smart App Control; it cannot be turned back on without resetting Windows) or wait for the signed release. Do not turn it off if you are unsure.");
out.push("- Check that the file is the one BIForge published: `SHA256SUMS` lists every file's hash and `SHA256SUMS.sig` is its signature (Ed25519). `biforge-cli verify-release --public-key " + (keyFile && fs.existsSync(keyFile) ? fs.readFileSync(keyFile, "utf8").trim() : "<docs/release-public-key.txt>") + " --dir <folder with the downloads>`; GitHub's build attestation: `gh attestation verify <file> --repo moelsaka01/BIForge`.");
out.push("");
out.push("## What is here, by the numbers");
if (total) out.push(`Of ${total.total} features inventoried (everything Power BI Desktop 2.158 does that does not need the cloud): **${total.done} done and tested (${pct(total.done, total.total)}%)**, ${total.partial} partial, ${total.none} not started.`);
out.push("");
out.push("| Area | Features | Done | Partial | Not started |");
out.push("| --- | ---: | ---: | ---: | ---: |");
for (const r of inv) out.push(`| ${r.area} | ${r.total} | ${r.done} | ${r.partial} | ${r.none} |`);
out.push("");
out.push("## What works (tested)");
for (const r of by.done) out.push(`- **${r.area}**: ${r.feature}`);
out.push("");
out.push("## Partial: works with limits");
for (const r of by.partial) out.push(`- **${r.area}**: ${r.feature}`);
out.push("");
out.push("## Known gaps and not verified");
for (const r of [...by.gap, ...by.none, ...by.deferred]) out.push(`- **${r.area}**: ${r.feature}`);
out.push("");
out.push("Not verified anywhere: opening BIForge projects in Power BI Desktop beyond the cases listed in COVERAGE.md; the public relay path of direct sessions; Google Drive and OneDrive against the real services (Dropbox was tested); Analysis Services against a real server; the assumed M semantics listed in `tests/m/README.md`.");
out.push("");
out.push("## Not in BIForge on purpose");
out.push("Microsoft cloud features (sign-in, Publish to the Power BI service, OneLake, Dataverse, Fabric, Copilot, sensitivity labels, cloud-only connectors). BIForge's own sharing (folders, GitHub Pages, your Google Drive / OneDrive / Dropbox, direct connections, a server you host) needs no account of ours and costs nothing. It is not made by or affiliated with Microsoft.");
console.log(out.join("\n"));
