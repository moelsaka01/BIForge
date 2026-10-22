// Writes the winget manifest (version, installer, default locale) for a release, with the hashes from its SHA256SUMS.
//   node tools/winget-manifest.mjs <version> <folder with SHA256SUMS> [out folder]
// Submission steps: docs/SIGNING.md ("winget").
import fs from "node:fs";
import path from "node:path";

const [version, dir, outArg] = process.argv.slice(2);
if (!version || !dir) {
  console.error("usage: node tools/winget-manifest.mjs <version> <folder with SHA256SUMS> [out folder]");
  process.exit(2);
}
const sums = Object.fromEntries(
  fs.readFileSync(path.join(dir, "SHA256SUMS"), "utf8").split(/\r?\n/).filter(Boolean).map((l) => { const [h, n] = l.split(/\s+/); return [n, h.toUpperCase()]; }),
);
const exe = Object.keys(sums).find((n) => /-setup\.exe$/i.test(n));
const msi = Object.keys(sums).find((n) => /\.msi$/i.test(n));
if (!exe || !msi) throw new Error("SHA256SUMS must list the setup program and the MSI");
const id = "moelsaka01.BIForge";
const base = `https://github.com/moelsaka01/BIForge/releases/download/v${version}`;
const out = path.resolve(outArg ?? path.join("packaging", "winget", "manifests", "m", "moelsaka01", "BIForge", version));
fs.mkdirSync(out, { recursive: true });
const schema = "1.6.0";
const head = (type) => `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${type}.${schema}.schema.json\n`;
fs.writeFileSync(path.join(out, `${id}.yaml`), `${head("version")}PackageIdentifier: ${id}\nPackageVersion: ${version}\nDefaultLocale: en-US\nManifestType: version\nManifestVersion: ${schema}\n`);
fs.writeFileSync(
  path.join(out, `${id}.installer.yaml`),
  `${head("installer")}PackageIdentifier: ${id}
PackageVersion: ${version}
InstallerLocale: en-US
Platform:
  - Windows.Desktop
MinimumOSVersion: 10.0.17763.0
Installers:
  - Architecture: x64
    InstallerType: nullsoft
    Scope: user
    InstallerUrl: ${base}/${exe}
    InstallerSha256: ${sums[exe]}
    InstallerSwitches:
      Silent: /S
      SilentWithProgress: /S
  - Architecture: x64
    InstallerType: wix
    Scope: machine
    InstallerUrl: ${base}/${msi}
    InstallerSha256: ${sums[msi]}
ManifestType: installer
ManifestVersion: ${schema}
`,
);
fs.writeFileSync(
  path.join(out, `${id}.locale.en-US.yaml`),
  `${head("defaultLocale")}PackageIdentifier: ${id}
PackageVersion: ${version}
PackageLocale: en-US
Publisher: BIForge contributors
PublisherUrl: https://github.com/moelsaka01/BIForge
PublisherSupportUrl: https://github.com/moelsaka01/BIForge/issues
PackageName: BIForge
PackageUrl: https://github.com/moelsaka01/BIForge
License: Apache-2.0
LicenseUrl: https://github.com/moelsaka01/BIForge/blob/main/LICENSE
Copyright: Copyright 2026 BIForge contributors
ShortDescription: Open-source desktop app for building data models and reports.
Description: BIForge builds data models and reports on your own computer. It opens and saves PBIP/TMDL projects, shares reports through folders, your own cloud storage, direct connections or a server you host, and needs no cloud account of its own. Early software; see the release notes for what works. Not made by or affiliated with Microsoft.
Moniker: biforge
Tags:
  - business-intelligence
  - data
  - reports
  - dax
  - open-source
ReleaseNotesUrl: https://github.com/moelsaka01/BIForge/releases/tag/v${version}
ManifestType: defaultLocale
ManifestVersion: ${schema}
`,
);
console.log("wrote", out);
