# Signing, updates and distribution

## What is signed today

| What | How | Key | Where the private half lives |
| --- | --- | --- | --- |
| `SHA256SUMS` of every release file | Ed25519 (`biforge-cli sign-release`) | `docs/release-public-key.txt` | GitHub Actions secret `BIFORGE_RELEASE_SIGNING_KEY` |
| The setup program (for the in-app updater) | minisign-style signature made by the Tauri bundler (`*-setup.exe.sig`) | `docs/updater-public-key.txt` (also in `tauri.conf.json`) | GitHub Actions secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` |
| Build provenance | GitHub artifact attestation (`gh attestation verify <file> --repo moelsaka01/BIForge`) | GitHub / Sigstore | n/a |
| Windows code signature (Authenticode) | **not yet** | needs a certificate | see "Status of code signing" below |

No private key is in the repository or on the developer's disk (they were generated and sent straight into the secrets). If the
updater key is lost, installed copies can no longer be updated automatically; a new key means a manual reinstall.

## Updates

BIForge checks `https://github.com/moelsaka01/BIForge/releases/latest/download/latest.json` shortly after it starts (About >
"Check for updates when BIForge starts" switches it off; About > "Check for updates" asks on demand). The setup program is downloaded and
verified against the updater public key before it is run; a failed or forged download is refused. Nothing but the request to GitHub is sent.

## Status of code signing (updated 2026-10-23)

**SignPath Foundation declined BIForge for now**: the project has too little public visibility. They invite a new application later;
reapply once BIForge has more users, stars and releases. Nothing in the repository needs to change for that (the prepared workflow
steps and `docs/CODE_SIGNING_POLICY.md` stay). Release notes say: "Code signing: not yet available; see the README for SmartScreen guidance."

## SignPath Foundation (free Authenticode signing for open-source projects) - declined, kept for reapplying

Checked on 2026-10-22 against <https://signpath.org/terms> (the application page <https://signpath.org/apply.html> is rendered by script, so its fields were not read).

**Conditions** (all five must be true of BIForge; "we are under no obligation to accept your project"):
- OSI-approved license for all components, no commercial dual-licensing: Apache-2.0, and every dependency is permissive. Yes.
- No proprietary code; system libraries are fine. Yes.
- Actively maintained. Yes.
- Already released in the form that will be signed: **the first public release v0.1.0 must exist first.**
- Functionality documented on the download page: the release notes and README.

**What the Foundation certificate adds** (they sign only what the signing team builds from its own source): no hacking tools, respect for
privacy, announced system changes, an uninstaller, multi-factor authentication for SignPath **and** for GitHub, named roles (authors,
reviewers, approvers; every signing request is approved by a team member, every release approved by hand), the product name set to
"BIForge" and the same product version in every build (the bundler sets both from `tauri.conf.json`), reproducible-from-source CI builds.
The certificate is issued to SignPath Foundation, so Windows shows SignPath Foundation as the publisher.

**What must be published:** a "Code signing policy" section on the home page and the release page (`docs/CODE_SIGNING_POLICY.md` is ready; the README links
it), with the line "Free code signing provided by SignPath.io, certificate by SignPath Foundation" (added only once accepted), the team roles, and a privacy statement
(the policy has it: BIForge sends nothing to other systems unless you ask, apart from the update check).

### Owner steps (exact)
1. Turn on two-factor authentication for your GitHub account (Settings > Password and authentication) and keep it on.
2. Publish the first release: push the tag `v0.1.0` (done by the release workflow; see the release page).
3. Open <https://signpath.org/apply.html> and fill the form: project name **BIForge**, repository **https://github.com/moelsaka01/BIForge**, license **Apache-2.0**, download page **https://github.com/moelsaka01/BIForge/releases**, your name and e-mail, a one-paragraph description (copy the first paragraph of the README), the statement that the build runs in GitHub Actions (`.github/workflows/release-app.yml`) and that releases are approved by hand, and a link to `docs/CODE_SIGNING_POLICY.md`.
4. When SignPath replies (reports say one or two business days): create your SignPath account with two-factor authentication, accept the invitation, and in SignPath create the project with slug **biforge** and a signing policy with slug **release-signing** that requires your approval.
5. In the GitHub repository settings, create the secret `SIGNPATH_API_TOKEN` (SignPath: your user > API tokens) and the variables `SIGNPATH_ORGANIZATION_ID` and `SIGNPATH_PROJECT_SLUG` (Settings > Secrets and variables > Actions). The workflow then signs the setup program, the MSI and both tools, re-signs the updater file, and the next release is signed. (The SignPath steps in `release-app.yml` are prepared and untested until then.)
6. After the first signed release, add the attribution line to the README and `docs/CODE_SIGNING_POLICY.md`, and remove the unsigned-download advice from the release notes generator (`tools/release-notes.mjs`).

Until then the README and every release's notes explain SmartScreen and Smart App Control.

## Free alternative: Microsoft Store (researched 2026-10-23, nothing built or submitted)

Sources are Microsoft Learn pages (dates in brackets) and Tauri's own docs, read on 2026-10-23. Re-check before acting; Microsoft changes these pages.

### 1. Is an individual Store developer account free? Yes, through one specific entry point
- Windows Developer Blog, 2025-09-10: individuals can publish "without paying any onboarding fees" and no credit card is needed; available in nearly 200 markets.
- Learn, "Open a developer account" (updated 2026-07-17): "no registration fees" for either account type; the free path is **only** <https://storedeveloper.microsoft.com> ("Get started for free", then "Individual developer"). Other entry points (Partner Center directly, Xbox, Visual Studio) show the **legacy flow, which may charge a fee** (the fee is not stated on the pages read).
- Needs: a **personal** Microsoft account, ID verification (government ID plus selfie, done on a phone), the App Developer Agreement. The country cannot be changed later.
- Eligibility: an Individual account is for people whose distribution is "not in relation to their business, trade, or profession" (hobby, personal, non-commercial). BIForge is free and open source, which fits. An Individual account cannot be converted to a Company account later (a new one is needed).
- One stale line on the "get started" FAQ mentions a verification email "after payment"; the newer account page contradicts it. If the sign-up ever asks for a payment, stop and do not pay.

### 2. Are Store packages signed by Microsoft, and do SmartScreen / Smart App Control accept them?
| Path | Signed by | Notes |
| --- | --- | --- |
| **MSIX** package submitted to the Store | **Microsoft re-signs it after certification, free** ("you don't need to purchase or manage a certificate") | Store hosts it and updates it. "Users will never see a SmartScreen warning for a Store-installed app." |
| **EXE/MSI** installer submitted to the Store ("EXE or MSI app") | **Not re-signed.** The installer and every PE file in it must be signed by you with a certificate chaining to the Microsoft Trusted Root Program; **self-signed is not accepted** | Needs a versioned HTTPS URL you host, silent install, offline install. Updates are your job. |

- Because BIForge has no certificate, the **EXE/MSI Store path does not solve the problem** (it needs the very certificate we lack). Only the **MSIX path** gives a free Microsoft signature.
- Smart App Control: Learn says it "may supersede" SmartScreen and "will block execution of unsigned files unless the file has a positive reputation". None of the pages read states outright that Store-installed MSIX apps are exempt. A Microsoft-signed package is not unsigned, so it should pass, but **this is an inference, not a documented guarantee**; verify on a Windows 11 machine with Smart App Control in Enforcement mode before relying on it.
- Certification can take up to three business days per submission (Learn, MSIX path).

### 3. Tauri and MSIX
- **Tauri 2 does not generate MSIX.** The official guide (<https://v2.tauri.app/distribute/microsoft-store/>, updated 2026-06-15) says "Currently Tauri only generates EXE and MSI installers" and covers only the EXE/MSI route (offline WebView2 via `src-tauri/tauri.microsoftstore.conf.json`, silent install `/S`, `bundle.publisher` different from `productName`, code-signed installer).
- Feature request [tauri-apps/tauri#4818](https://github.com/tauri-apps/tauri/issues/4818) "Build MSIX packages" is open since 2022-08; related: #15145 (MSIX dev-mode debugging, open), PR #15795 (`tauri dev --packaged`, open, unmerged, waits for #4818), #8548 (closed). Nothing is merged.
- Bug [#14935](https://github.com/tauri-apps/tauri/issues/14935): a fresh Tauri 2 app failed the Windows App Certification Kit (blocked executables such as `cmd.exe`, `CreateProcessW`, `ShellExecuteW`), reported while packaging with the MSIX Packaging Tool / cargo-packager; status "needs triage". BIForge also starts other programs (the optional server, the browser for links), so expect the same kind of finding.
- So MSIX means **our own packaging step**: write an `AppxManifest.xml`, lay out the built `biforge-app.exe` (plus WebView2 dependency handling, the optional server/CLI, icons), run `MakeAppx.exe` (Windows SDK), or use Microsoft's MSIX Packaging Tool / winapp CLI; upload the unsigned `.msix` to Partner Center (the Store signs it). The tools named in the issues (cargo-packager, MSIX Packaging Tool, winapp CLI) were not evaluated.
- **Not verified here** (general MSIX knowledge; check in Partner Center before building): a full-trust desktop app declares the restricted capability `runFullTrust`, which Partner Center may ask you to justify; Store policy normally disallows an app updating itself outside the Store, so the in-app updater (GitHub `latest.json`) would be switched off in the Store build, and the `biforge://` / `.biforge` registrations and single-instance behavior would have to be declared in the manifest; user data lives in a per-package location (see tauri#9936).
- Effort: a separate "Store build" mode, a packaging script and a WACK run; the main risks are the WACK findings and `runFullTrust`.

### 4. Options and recommendation (decision is yours)
1. **Wait and reapply to SignPath** later (free, no work; users keep seeing SmartScreen).
2. **Store via MSIX** (free signature, no SmartScreen, Store updates; needs the custom packaging work and passing certification; a second channel next to GitHub). Worth a small spike first (build an MSIX locally, run WACK); a local spike needs no account.
3. **Store via EXE/MSI**: not possible without a certificate; skip.
4. Paid certificates (Azure Artifact/Trusted Signing, OV/EV) are not free and were not researched here.

### Owner steps (Microsoft Store individual account and first submission; do nothing until you decide)
Account (free; about 15 minutes):
1. Have a **personal** Microsoft account ready (outlook.com, hotmail or any personal account; not a work or school account), a phone with a camera, your original government ID and good light.
2. Open <https://storedeveloper.microsoft.com> (do **not** start from Partner Center directly: that can show the legacy, possibly paid, flow). Click **Get started for free**, sign in, choose **Individual developer**.
3. Choose the country carefully (it cannot be changed), do the ID and selfie check on the phone, review the auto-filled profile, set the **Publisher display name** (the name users see; "BIForge" or your own name), accept the App Developer Agreement. If any step asks for a card or a payment, stop.
4. Open <https://aka.ms/submitwindowsapp> (Partner Center, Apps and games) to confirm the account works.

Submission (only after the packaging work exists):
5. Apps and games > **New product** > **MSIX or PWA app**, reserve the name "BIForge" (a reservation expires after three months if unused).
6. Copy **Package/Identity/Name**, **Publisher** (a `CN=...` string) and **Publisher display name** from Partner Center (Product management > Product identity) into the AppxManifest (I can script this).
7. Start a **submission**: Pricing and availability (Free, markets, visibility), Properties (category, **privacy policy URL**: BIForge sends nothing apart from the update check, say so on a page I add), age rating questionnaire, Packages (upload the `.msix`; Partner Center validates it), Store listings (description, screenshots from `docs/media`, icons), Notes for certification (explain `runFullTrust` and how to test: open the sample project).
8. Submit and wait for certification (up to three business days). Fix report items and resubmit. After approval the Store signs and publishes the package.
9. Afterwards add the Store link to the README; keep the unsigned GitHub installers for users who prefer them.

## winget (free)

`tools/winget-manifest.mjs <version> <folder with SHA256SUMS>` writes the three manifest files (`moelsaka01.BIForge`); the release workflow attaches them as `winget-manifest.zip`.

1. Install the tools once: `winget install Microsoft.WingetCreate` (optional) and have a GitHub account.
2. Download `winget-manifest.zip` from the release and unpack it. Check it: `winget validate --manifest <folder>`.
3. Fork <https://github.com/microsoft/winget-pkgs>, copy the folder to `manifests/m/moelsaka01/BIForge/<version>/`, commit, and open a pull request titled `New package: moelsaka01.BIForge version <version>`. Sign the Contributor License Agreement when the bot asks.
4. The pull request runs automatic validation (it installs the package in a sandbox and scans it). An unsigned installer is accepted but may need a maintainer's look; answer review comments in the pull request.
5. For later versions: `wingetcreate update moelsaka01.BIForge --version <v> --urls <setup url> <msi url> --submit` (or repeat step 3).
