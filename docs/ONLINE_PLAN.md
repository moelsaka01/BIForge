# BIForge online track (Publish & Share)

Decided 2026-10-17. This is BIForge's **own** sharing system. It is not Microsoft's cloud: Power BI sign-in, OneLake, "Publish to the Power BI service" and the like stay excluded (docs/COVERAGE.md, "Excluded (cloud)"). Research behind the choices: research/online-reuse.md.

## Fixed decisions (binding; ask the owner before changing any)
- **Desktop only.** Every viewer uses the free BIForge app. No browser viewer, no web embedding. A *viewing mode* (read-only reading view) and `biforge://` deep links open shared content in the app.
- **Zero cost, always.** No BIForge-operated servers, no paid tiers, no payment card anywhere, nothing that makes the owner or a user pay. No Docker. Every free-tier limit shown in the UI must be accurate; a provider that asks for a card is dropped and the reason documented.
- **License.** Apache-2.0 for all BIForge code including servers. Dependencies Apache-2.0 / MIT / BSD / ISC only. Never copy AGPL/GPL code (Metabase, Grafana are design references only).
- **Additive.** New crates and modules; the desktop stays fully usable offline; cloud code loads only when Publish & Share is used; existing projects stay compatible (new files live under `<project>/.biforge/publish/`, which older versions ignore).
- **Security.** No secrets in packages (scanned on build); tokens, signing key and access keys only in Windows Credential Manager; static publishing lists the exact tables and columns that leave the machine and needs an explicit confirmation of that list; row-level security is never claimed outside method D; audit events for publish, share, revoke.

## Architecture: one publishing engine, four methods
```
 report ──prune──▶ package (.biforge) ──▶ Adapter ──▶ destination
 project   (chosen tables/   signed ed25519,           A static hosting   B personal storage
 + data     columns only)     encrypted (age)          C peer to peer     D backend (+ local folder)
 snapshot                     for private
```
- **Package** (crates/publish, `package.rs`): a zip with `envelope.json` (package id, version, publisher key, payload hash), `envelope.sig` (ed25519 over the envelope bytes) and `payload.bin` (zip of `manifest.json`, `project/**` PBIP files, `data/*.parquet`; age-encrypted for Private). The manifest lists version, publisher, access level, included tables/columns, permissions and a hash for every file. Checks on open, in this order: envelope signature, optional pinned publisher, payload hash, decryption, manifest/envelope agreement, every file hash, safe paths, size limits. Packages never claim RLS.
- **Access levels.** Public (not encrypted) and Private (encrypted to an *access key*, an age X25519 key pair). Anything non-public is encrypted by default. Revoking access = key rotation: the next version is encrypted for a new key; the old key cannot open it; copies already downloaded stay readable (the UI says so).
- **Adapter interface** (`adapter.rs`): `validate`, `authenticate`, `publish`, `update`, `status`, `share_link`, `sync`, `unpublish`, `disconnect`, plus `info()` carrying **capabilities** and **limitations** and the provider's **free-tier limits**. The UI offers an action only when the capabilities declare it and the Rust `Publisher` refuses it again. Adapters not built yet are listed as "Not implemented (planned Ox)" and every operation fails; nothing is simulated.
- **Targets.** A report has any number of publication targets (`targets.json`: adapter, label, settings without secrets, access level, account name, package id, last version, last sync, version history, status, last error) and an append-only `audit.jsonl`.
- **Viewing mode.** `DocumentStore.loadReadOnly` makes every change, undo and redo throw; the command registry has a guard that refuses everything except windows, panes, paging, drilling and leaving; the ribbon is replaced by a viewing bar (publisher, key id, version, access, data list); the report canvas has no move/resize/delete/rename/new page. The package is unpacked into a cache folder under `%LOCALAPPDATA%\BIForge\viewing\<packageId>` and its Parquet snapshots are loaded into a store of their own.
- **Deep links.** `biforge://open?src=file&path=<encoded>` today; `src=url|p2p|server` reserved and reported as "not supported by this version". A link never carries an access key and never opens anything by itself: the app first shows the confirmation (path, signature, publisher key, version, access). OS registration of the scheme (Tauri deep-link plugin + single-instance, installer entry) is part of O8; today the app reads a `biforge://` link or `.biforge` path from its start-up arguments and has an in-app "paste a link" box.
- **Collaboration data (O6).** yrs (Yjs port) for comments and co-editing, carried over P2P, storage sync and the backend.

## Methods and phases
| Phase | Content | State |
| --- | --- | --- |
| O0 | Research and reuse matrix (research/online-reuse.md) | Done 2026-10-17 |
| O1 | crates/publish, folder adapter, viewing mode, deep links, Publish & Share dialog, setup pop-ups | Done 2026-10-17 (see COVERAGE.md for what is tested) |
| O2 | **A. Static hosting**: GitHub Pages and Cloudflare Pages adapters; BIForge subscribes to a feed URL and pulls updates; public or encrypted-private; pinned publisher key (trust on first use) | Not started |
| O3 | **B. Personal storage**: Google Drive, OneDrive, Dropbox via OAuth with PKCE (public clients, no secret shipped, loopback redirect), tokens in Credential Manager, sync, conflict detection, provider permissions, version history where the provider has it. Needs the owner to register apps (steps will be given in the session) or users to bring their own client id | Not started |
| O4 | **C. P2P** with iroh (encrypted QUIC, hole punching, relay fallback): pairing code, explicit approval, read-only/edit roles, expiry, revocation, "can't connect, use another method"; "Host from this PC" can act as relay | Not started |
| O5 | **D. Backend**: "Host from this PC" and a standalone `biforge-server.exe` (axum) embedding the engine crates for real refreshes and DAX; workspaces, roles, comments, version history, audit log, server-side authorization, per-user RLS (only this method enforces RLS). Research free no-card hosting; if none, document that | Not started |
| O6 | Collaboration: comments, versions, co-editing where the method supports it (yrs) | Not started |
| O7 | Scheduled refresh: GitHub Actions workflow running a headless `biforge-cli refresh`, this PC (Task Scheduler), a server, or an authorized peer | Not started |
| O8 | Integration, security review, docs, installer update (deep-link registration, `.biforge` file association) | Not started |

Later online phases alternate with desktop parity phases 7 to 13 (docs/MASTER_PLAN.md), one phase per session.

## Capability matrix (target; today only the folder adapter is real)
| | Folder | A. Static | B. Storage | C. P2P | D. Backend |
| --- | --- | --- | --- | --- | --- |
| Public / encrypted private | yes / yes | yes / yes | yes / yes | session only | yes / yes |
| Update, sync | yes | yes (pull) | yes (pull) | live | yes |
| Share link | yes | yes | provider link | pairing code | invite link |
| Revoke | key rotation / unpublish | key rotation / unpublish | provider permissions + rotation | end session | server-side |
| Version history | list kept in the target | repo history | provider versions where available | no | yes |
| Scheduled refresh | no | GitHub Actions | no | no | yes |
| Row-level security | **no** | **no** | **no** | **no** | **yes (only here)** |
| Account | none | free GitHub / Cloudflare | Google / Microsoft / Dropbox | none | none (your server) |

## Setup pop-ups (every method; implemented as data in `app/src/core/publish/guides.ts`, tested)
Shown the first time a method is used; plain language; buttons do the next step; "Don't show again" is stored as an app option (`publish.guide.<id>.hidden`); the provider's free-tier limits come from the adapter's `freeTier`; a button for something not built is disabled and says which phase builds it.
- Backend hosting: Turn on Host from this PC / Download biforge-server.exe / How it works.
- Backend connecting: enter the server address or open the invite link; nothing to install.
- Static hosting: public vs encrypted-private, free GitHub/Cloudflare account, the tables and columns that leave the computer; Connect GitHub / Connect Cloudflare.
- Personal storage: shares the editable project, not a live dashboard; which account; Connect Google Drive / OneDrive / Dropbox.
- P2P: both must be online, may fail on some networks, which method to use instead; Start session / Join with code.
- Scheduled refresh: where it runs (GitHub Actions, this PC, a server) and what must stay on.
- Folder: no account; public vs private; the data list. (Real today.)

## Rules for online items
- Tracked in docs/COVERAGE.md like desktop items; Done only with a passing automated test.
- When something needs the owner (a free app registration, a login), the session gives click-by-click steps and continues with other work.
- Never commit secrets, tokens or client secrets.
