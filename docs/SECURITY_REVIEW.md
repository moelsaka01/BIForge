# Security review of the online track (O8, 2026-10-22)

Scope: everything added by phases O1 to O7 that touches a network, a second user, the file system on behalf of someone else, or Windows
(packages and deep links, the server, direct sessions, personal-storage sign-in, co-editing and comments, scheduled refresh,
the installer and the release files). Method: reading the code paths that take input from outside, writing the attack as a
test first where it could be tried on this machine, then fixing. This is a review by the author of the code with automated tests,
not an independent audit; no penetration test was done.

## Who is trusted

| Party | Can do | Is not trusted to |
| --- | --- | --- |
| Server administrator (holds the admin token) | everything in the server | - |
| Editor of a workspace | upload and publish reports, change data roles, start and edit together, send refresh bundles and source files | read files of the server computer, make the server connect elsewhere, sign as another person, see other workspaces |
| Viewer | read the reports they are given (rows filtered by their data roles), write comments | upload, change roles, see unfiltered rows |
| Guest of a direct session | what the host approved (read-only or edit) | anything before approval; anything after the host ends access |
| Anyone on the network | reach the server's port, try an invitation | anything without a valid token |
| A link or file from outside | be shown a confirmation | open anything by itself, touch another computer |

## Findings and what was done

| # | Where | Finding | Severity | Fix | Test |
| --- | --- | --- | --- | --- | --- |
| 1 | Server refresh | A refresh bundle is signed by an editor, and its config named the sources to reload. A source path outside the bundle (`C:/Windows/...`, `../x`) or a database or web source would have made the **server** read any of its files or connect to any address for an editor (privilege escalation, file disclosure to viewers, SSRF). | High | A bundle may name only file kinds (csv, excel, json, parquet, sqlite) and only paths below `data/src/` inside itself; the same rule in the GitHub runner's command line. | `a_refresh_bundle_cannot_make_the_server_read_other_files_or_connect_elsewhere` (absolute path, climbing path, database, web) |
| 2 | Deep links | `biforge://open?src=file&path=\\attacker\share\x.biforge` made the app read a file on another computer to show the confirmation, which sends the user's Windows credentials (NTLM) to that computer. | High | Links to network paths (`\\host\share`, `//host/share`) are refused. Opening such a file from the file dialog or by double click (the user's own act) is unchanged. | `deeplink::tests::rejects_bad_links` |
| 3 | Server | The invitation endpoint needs no token and had no limit. | Medium | At most 30 attempts per minute for the server; then 429. (Tokens are 256-bit, so guessing was not practical; the limit stops log flooding and slow probing.) | `invitations_cannot_be_guessed_at_speed` |
| 4 | Server | One request-size limit (512 MB) for every route, including small JSON. | Medium | 2 MB for ordinary routes; 512 MB only for report upload, refresh bundle and source file; 64 MB for one round of co-editing. | `a_big_body_is_refused_on_the_small_routes` |
| 5 | Server | Plain HTTP only. | High | TLS with a self-signed certificate made on the first start; the invitation link carries the SHA-256 fingerprint (`pin=`); clients accept exactly that certificate (handshake signatures are still verified, names are not trusted). Plain HTTP only with `--no-tls`. | `tls_with_a_pinned_self_signed_certificate`, `the_same_flow_over_tls_with_the_certificate_pinned_by_the_link`, real windows `o5.mjs`, `o6.mjs` |
| 6 | Server (earlier, found in O5) | A report id with encoded slashes could climb out of a workspace folder. | High | Every path from an id goes through one check. | `a_report_id_cannot_reach_another_workspace` |
| 7 | Co-editing | An edit-role peer can send any project JSON. When the host saves, file names are checked (`validate_key`: no `..`, drive letters, backslashes, absolute paths, control characters), and the folders and the project name are never taken from the peer (they stay local). | Checked, no change | none needed | existing `project.rs` tests; `jsonYjs.test.ts` keeps the local paths local |
| 8 | Comments | The author of a comment is taken from the token (server) or from the host's own record of the guest (direct session), never from the request; text is limited to 4000 characters and shown as text (React escapes it). | Checked | n/a | `co_editing_through_the_server_and_comments_with_mentions`, `co_editing_and_comments_over_a_direct_session` |
| 9 | Server | Source file names uploaded to a report's source folder: letters, digits, space, dot, dash, underscore only; no leading dot; no path. | Checked | n/a | same test as 1 (`../evil.csv` refused) |
| 10 | Scheduled refresh on this PC | The scheduled task starts the app with `--run-scheduled <project folder> <destination id>`; the destination id is reduced to letters, digits, `-` and `_`; the task runs as the signed-in user only while signed in, no stored password, one instance at a time. The credentials a refresh uses stay in Windows Credential Manager. | Checked | n/a | `scheduled::tests` (the XML has no user id or password; the task is registered and removed again on this machine) |
| 11 | Release files | The installer is not Authenticode-signed (needs a paid certificate). | Accepted, documented | `SHA256SUMS` signed with BIForge's Ed25519 release key (public key in the repository), plus a GitHub build attestation; `biforge-cli verify-release` checks both the signature and every hash. | `release::tests` |
| 12 | Dependencies | `npm audit` (production): 2 low advisories in DOMPurify inside Monaco (a sanitizer option BIForge does not use). | Low, accepted | Monaco stays on its current version; revisit when a fixed release exists. | n/a |

## Residual risks (known, not fixed)

- **Edit role means trust.** A peer with the edit role (direct session) or an editor (server) can change queries and measures. The
  next refresh on the host's PC runs those queries, which can read files on that PC. Give the edit role only to people you trust
  with your computer's files. A viewer cannot do this.
- **A server administrator reads all data.** Reports are stored unencrypted on the server (it has to read them to answer queries).
- **TLS key at rest.** `<data>/tls/key.der` is an unencrypted file; protect the server's data folder with Windows permissions.
  The certificate is valid for ten years and is not rotated automatically (delete `<data>/tls` and restart to make a new one;
  old invitation links then stop working).
- **No query time limit** on the server: an editor or viewer can send an expensive DAX query. There is no per-user quota.
- **The pin protects the connection, not the first link.** An invitation link that is intercepted before it is used lets the
  interceptor join in the invited person's place (links work once and expire; send them over a channel you trust).
- **Relays and discovery of direct sessions** (iroh public relays, DNS) see connection metadata, never content; this path has not been exercised
  in a test (see docs/COVERAGE.md).
- **Windows SmartScreen** warns about the unsigned installer.
- **Concurrent edits to the same property** are decided by the shared document (one of the two wins, the same one for everybody);
  undo history ends when another person's change arrives, so one person's undo can never remove another's work.
- No third-party review, no fuzzing of the package or Yjs update decoders (both reject malformed input with an error; fuzzing is future work).
