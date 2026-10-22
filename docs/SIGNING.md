# Signing, updates and distribution

## What is signed today

| What | How | Key | Where the private half lives |
| --- | --- | --- | --- |
| `SHA256SUMS` of every release file | Ed25519 (`biforge-cli sign-release`) | `docs/release-public-key.txt` | GitHub Actions secret `BIFORGE_RELEASE_SIGNING_KEY` |
| The setup program (for the in-app updater) | minisign-style signature made by the Tauri bundler (`*-setup.exe.sig`) | `docs/updater-public-key.txt` (also in `tauri.conf.json`) | GitHub Actions secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` |
| Build provenance | GitHub artifact attestation (`gh attestation verify <file> --repo moelsaka01/BIForge`) | GitHub / Sigstore | n/a |
| Windows code signature (Authenticode) | **not yet** | needs a certificate | see "SignPath" below |

No private key is in the repository or on the developer's disk (they were generated and sent straight into the secrets). If the
updater key is lost, installed copies can no longer be updated automatically; a new key means a manual reinstall.

## Updates

BIForge checks `https://github.com/moelsaka01/BIForge/releases/latest/download/latest.json` shortly after it starts (About >
"Check for updates when BIForge starts" switches it off; About > "Check for updates" asks on demand). The setup program is downloaded and
verified against the updater public key before it is run; a failed or forged download is refused. Nothing but the request to GitHub is sent.

## SignPath Foundation (free Authenticode signing for open-source projects)

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

## winget (free)

`tools/winget-manifest.mjs <version> <folder with SHA256SUMS>` writes the three manifest files (`moelsaka01.BIForge`); the release workflow attaches them as `winget-manifest.zip`.

1. Install the tools once: `winget install Microsoft.WingetCreate` (optional) and have a GitHub account.
2. Download `winget-manifest.zip` from the release and unpack it. Check it: `winget validate --manifest <folder>`.
3. Fork <https://github.com/microsoft/winget-pkgs>, copy the folder to `manifests/m/moelsaka01/BIForge/<version>/`, commit, and open a pull request titled `New package: moelsaka01.BIForge version <version>`. Sign the Contributor License Agreement when the bot asks.
4. The pull request runs automatic validation (it installs the package in a sandbox and scans it). An unsigned installer is accepted but may need a maintainer's look; answer review comments in the pull request.
5. For later versions: `wingetcreate update moelsaka01.BIForge --version <v> --urls <setup url> <msi url> --submit` (or repeat step 3).
