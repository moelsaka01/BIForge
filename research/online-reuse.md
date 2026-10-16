# Online track: reuse matrix and provider facts (Phase O0)

Written 2026-10-17. Original notes only. "Verified" means a web source was read in this session (listed at the end); "Unverified" means from memory or a secondary source and must be checked before the phase that depends on it. Licenses of crates marked "recorded" were read from the crate metadata/repo at the time of integration (O1 crates are checked by `cargo tree`/`cargo metadata` in tests/CI notes below); the others are from memory and are re-checked when the crate is first added.

## 1. Reuse matrix

Rule: Apache-2.0 / MIT / BSD / ISC only. Never copy AGPL/GPL code (Superset is Apache, Metabase is AGPL, Grafana is AGPL, Lightdash is MIT for the core but has an enterprise directory under a different license, Evidence is MIT): design references only, no code taken.

| Item | URL | Reusable functionality | License | Maintenance | Effort | Security risks | Decision |
| --- | --- | --- | --- | --- | --- | --- | --- |
| iroh | github.com/n0-computer/iroh | Encrypted QUIC between node ids, hole punching, relay fallback, blobs/gossip/docs protocols | Apache-2.0 / MIT | Very active, pre-1.0, API changes between minors | High (O4) | Relay sees metadata (not payload). Public relays have no SLA | **Reuse** for P2P (O4). Pin a version; wrap behind our own `Transport` trait |
| yrs | github.com/y-crdt/y-crdt | Yjs-compatible CRDT: text, maps, arrays, awareness, sync protocol | MIT | Active | Medium (O6) | Untrusted updates must be size-limited and applied in a sandboxed doc | **Reuse** for co-editing and comments (O6). Preferred over automerge: smaller binary, awareness protocol, same wire format as any later web tooling |
| automerge | github.com/automerge/automerge | CRDT with history | MIT | Active | Medium | Same | Alternative only; not used unless yrs fails the O6 spike |
| age / rage | github.com/str4d/rage (crate `age`) | File encryption: X25519 recipients, scrypt passphrase, streaming ChaCha20-Poly1305 | Apache-2.0 / MIT | Active, audited design | Low | None known; passphrase mode is scrypt-hard | **Reuse** (used in O1 for package encryption) |
| ed25519-dalek | github.com/dalek-cryptography/curve25519-dalek | ed25519 signatures | BSD-3-Clause | Active | Low | Use `verify_strict` | **Reuse** (O1) |
| axum | github.com/tokio-rs/axum | HTTP server for biforge-server.exe | MIT | Very active | Medium (O5) | Standard web risks; we add authz middleware | **Reuse** (O5) |
| oauth2 crate | github.com/ramosbe/oauth2-rs (crates.io `oauth2`) | Auth-code + PKCE flow, token refresh | MIT / Apache-2.0 | Active | Low | Loopback redirect must bind 127.0.0.1 and check `state` | **Reuse** (O3) |
| keyring | github.com/hwchen/keyring-rs | Windows Credential Manager (already used by BIForge for DB passwords) | MIT / Apache-2.0 | Active | Done | Credentials readable by same Windows user | **Reuse** (already in repo) |
| tauri-plugin-deep-link | github.com/tauri-apps/plugins-workspace | `biforge://` scheme registration, URL events, single-instance hand-off | MIT / Apache-2.0 | Official, active | Low | Deep-link input is untrusted: parse strictly, never act without a confirmation dialog | **Reuse** in the installer-built app (O1 implements the parser and in-app handling; the OS registration is wired with the plugin at installer time, O8 — see ONLINE_PLAN) |
| reqwest | github.com/seanmonstar/reqwest | HTTP client for provider REST APIs | MIT / Apache-2.0 | Active | Low | TLS via rustls | **Reuse** (already planned for Web connector) |
| GitHub REST API (Pages, contents, Actions) | docs.github.com/rest | Create repo, push files, enable Pages, dispatch workflows | API terms (no code reused) | Stable | Medium (O2) | Token scope: use fine-grained PAT or device flow; never store in repo | **Build** thin client with reqwest; octocrab (Apache/MIT) considered, rejected as large for a handful of endpoints |
| Cloudflare Pages API | developers.cloudflare.com/pages | Direct Upload of a static site by API token | API terms | Stable | Medium (O2) | API token with narrow scope, Credential Manager | **Build** thin client |
| Google Drive API v3 | developers.google.com/drive | Files, revisions (version history), permissions, changes feed | API terms | Stable | Medium (O3) | `drive.file` scope only (per-file access) | **Build** thin client |
| Microsoft Graph (OneDrive) | learn.microsoft.com/graph | driveItem upload, versions, sharing links, delta | API terms | Stable | Medium (O3) | Least-privilege `Files.ReadWrite.AppFolder` or `Files.ReadWrite` | **Build** thin client |
| Dropbox API v2 | dropbox.com/developers | files upload/list_revisions, sharing | API terms | Stable | Medium (O3) | App folder access type | **Build** thin client |
| Parquet (arrow-rs `parquet` crate or DuckDB COPY) | — | Data snapshot format | Apache-2.0 | Active | Low | None | **Reuse DuckDB `COPY ... TO parquet`** already in the engine (O1 snapshots are written through the engine in the app layer; the publish crate stores opaque files) |
| zip | crates.io `zip` | Package container | MIT | Active | Low | Zip-slip: reject unsafe paths | **Reuse** (O1) |
| Apache Superset | github.com/apache/superset | Design reference: dashboards, RLS filter clauses, roles | Apache-2.0 | Active | — | — | **Design reference only** (Python/JS, different architecture) |
| Metabase | github.com/metabase/metabase | Design reference: collections, permissions, embedding | AGPL-3.0 | Active | — | AGPL: **do not copy** | Reference only |
| Lightdash | github.com/lightdash/lightdash | Design reference: semantic layer sharing | MIT (+ enterprise dir) | Active | — | Avoid ee/ directory | Reference only |
| Grafana | github.com/grafana/grafana | Design reference: provisioning, alerting, snapshots | AGPL-3.0 | Active | — | **Do not copy** | Reference only |
| Evidence | github.com/evidence-dev/evidence | Design reference: static, git-based publishing of data apps | MIT | Active | — | — | Reference only; confirms the static-hosting model |
| Additional candidates found by searching | | | | | | | |
| Syncthing | github.com/syncthing/syncthing | Decentralised file sync (Go) | MPL-2.0 | Active | — | Out-of-process, license is file-level copyleft | Not embedded; users may point the **file/folder adapter** at a Syncthing folder (free P2P sync without code from us) |
| magic-wormhole.rs | github.com/magic-wormhole/magic-wormhole.rs | Pairing code → one-shot transfer via public rendezvous server | EUPL-1.2 | Moderate | — | EUPL is not on our allow-list | Rejected; pairing-code UX is done on top of iroh tickets |
| sled / redb | github.com/cberner/redb | Embedded KV for server state | MIT/Apache-2.0 | Active | Low | — | Candidate for O5 server store; may simply use SQLite file via `rusqlite` (MIT) or DuckDB. Decide in O5 |
| tower-sessions / argon2 | crates.io | Server sessions, password hashing | MIT / MIT+Apache | Active | Low | — | Candidates for O5 |

## 2. Provider facts

| Provider | App registration needed? | Payment card? | Free-tier quotas | Notes |
| --- | --- | --- | --- | --- |
| GitHub Pages | No app needed if the user pastes a fine-grained token, or we register an OAuth app (device flow, no secret) | No | Verified: Pages on the Free plan only for **public** repositories; private-repo Pages needs a paid plan. Site ≤ 1 GB, soft 100 GB/month bandwidth, 10 builds/hour soft (not for Actions deployments), 10-minute deploy timeout | So "private" on GitHub Pages means **encrypted package in a public repo**, never access control. UI must say so |
| GitHub Actions | — | No | Verified: free standard runners are unlimited for **public** repos; private repos get a monthly quota (2,000 minutes on Free, from the plan docs; check the current pricing page, billing text in the results did not state it) | Scheduled workflows in public repos are disabled after 60 days without repo activity (Unverified — check in O7) |
| Cloudflare Pages | Account + API token (user-created); no BIForge app | Unverified: UCLA guide and a roundup say no card for Pages; one report says R2 asks for a card. **Do not use R2.** Re-verify at signup in O2 | Verified: 500 builds/month (not used for Direct Upload), 20,000 files/site, 25 MiB/file, 100 custom domains | If Pages ever asks for a card, adapter is dropped and documented |
| Google Drive | Yes: a Google Cloud project + OAuth client ("Desktop app" type) maintained by whoever ships the app, plus a consent screen. Needs the user (owner) to do it: steps will be given in O3 | No (Cloud project creation is free for OAuth only) | Verified: `drive.file` is a non-sensitive scope (basic verification). Unverified: Testing-mode consent screens cap at 100 test users and refresh tokens expire in 7 days; production without verification shows an "unverified app" warning and a 100-user cap until verified; 100 refresh tokens per account per client | Each BIForge user could register **their own** client id (Options) to avoid the shared cap; document both |
| OneDrive (Graph) | Yes: Entra app registration, "personal Microsoft accounts" supported, public client with PKCE, no secret | No (Unverified: personal Microsoft account + tenant-less registration is free; an Azure subscription is not required for consumer-only registration, confirm in O3) | 5 GB free OneDrive (Unverified current number) | Same "bring your own client id" option |
| Dropbox | Yes: app on dropbox.com/developers, "App folder", PKCE works without the secret (Verified via Dropbox staff posts) | No | Basic plan 2 GB (Unverified current number); development apps limited to 500 linked users until production-approved (Unverified) | |
| iroh public relays | No | No | Verified: free, **no SLA**, rate-limited across all users, latest stable iroh only, docs advise not using for sensitive data (metadata visible). Formal terms of service not found in the sources read | Plan: ship with the public relay list, show the notice in the P2P pop-up, offer "Host from this PC as relay" (iroh-relay is Apache/MIT and can run inside the host) and a custom relay URL |
| Free hosting for biforge-server (O5) | — | — | Not yet researched; known candidates (Oracle Cloud always-free, Fly.io, Render, Koyeb, Cloudflare Workers) mostly ask for a card or cannot run a long-lived DuckDB process. Plan: assume **none** qualifies and document "Host from this PC" and "your own always-on computer"; research again in O5 | |

## 3. Free scheduled refresh options (for O7)
1. **GitHub Actions cron** in the user's public repo (free, unlimited on public repos; runs the headless `biforge-cli refresh`; only works for sources reachable from GitHub's runners, i.e. public URLs/files in the repo — not a database on the user's LAN; credentials as Actions secrets).
2. **This PC**: Windows Task Scheduler entry that runs `biforge-cli refresh && publish`. Works for any local source; PC must be on.
3. **Host from this PC / biforge-server.exe**: the server's own scheduler.
4. **Delegated peer**: an authorized peer (a P2P node or a server with a "refresher" role) runs the refresh with its own access and pushes the result; the manifest records who refreshed and when. Needs O4/O5.
Each option's pop-up states where the refresh runs and what must stay on.

## 4. Sources read this session
- docs.iroh.computer (public relays, concepts/relays, FAQ) via search summary
- docs.github.com (GitHub Pages limits; Actions billing)
- developers.cloudflare.com/pages/platform/limits
- developers.google.com/workspace/drive/api/guides/api-specific-auth; developers.google.com/health/setup (testing-mode refresh token expiry)
- learn.microsoft.com Entra quickstarts (desktop, PKCE); nango.dev registration guide (third party)
- dropboxforum.com threads on PKCE without secret
Search results gave summaries, not full pages; items marked Unverified need a direct read of the vendor page before the adapter phase.
