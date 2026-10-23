# Code signing policy

Status: **no Windows code-signing certificate yet.** SignPath Foundation declined the project for now (see [SIGNING.md](SIGNING.md), which also
lists the other free options). Until a certificate exists the installers are unsigned; releases carry a signed `SHA256SUMS`, a
signed updater file and a GitHub build attestation instead.

## Roles (when signing starts)
- **Authors and committers:** the maintainers of https://github.com/moelsaka01/BIForge (currently the owner, moelsaka01).
- **Reviewers:** a change reaches `main` only after the automated tests pass; releases are reviewed by the owner.
- **Approvers:** the owner approves every signing request by hand; there is no automatic signing.

## What is signed
Only binaries built by the project's own GitHub Actions workflow (`.github/workflows/release-app.yml`) from this repository:
the installers, `biforge-server.exe` and `biforge-cli.exe`. Product name "BIForge", the version from `tauri.conf.json`.

## Privacy
This program will not transfer any information to other networked systems unless specifically requested by the user or the
person installing or operating it. The only automatic request is the check for a newer version at start (a request to GitHub Releases; it can be switched off in
About). Sharing features contact only the destinations and people you choose.
