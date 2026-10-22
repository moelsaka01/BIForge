# Sharing, working together and refreshing (user guide)

BIForge shares reports without any cloud service of its own and without a payment card. Everyone who looks at or edits a shared
report uses the free BIForge desktop app. Row-level security exists only on a server (method D). The design and its limits are in
[ONLINE_PLAN.md](ONLINE_PLAN.md); what was tested, and how, is in [COVERAGE.md](COVERAGE.md); the security review is [SECURITY_REVIEW.md](SECURITY_REVIEW.md).

## Install

Download `BIForge_<version>_x64-setup.exe` from the GitHub release. It installs for the current user (no administrator rights),
registers `biforge://` links and `.biforge` files with Windows, and puts BIForge in the Start menu. Check the download first:

```
biforge-cli verify-release --public-key <contents of docs/release-public-key.txt> --dir <folder with the files, SHA256SUMS and SHA256SUMS.sig>
```

The installer is not Authenticode-signed (that needs a certificate that costs money), so Windows SmartScreen may warn about it;
the signature above and the GitHub build attestation (`gh attestation verify <file> --repo moelsaka01/BIForge`) show where it came from.
BIForge starts once per user: opening a `.biforge` file or a `biforge://` link while it runs hands it to the open window, which asks
before it opens anything.

## Choose how to share (Publish & Share)

| You want | Use | Needs | Row-level security |
| --- | --- | --- | --- |
| Hand a file to colleagues | Folder on this PC or network | nothing | no |
| A web address anyone with the link can open | GitHub Pages (or Cloudflare) | a free account | no |
| Your own Google Drive, OneDrive or Dropbox | Personal storage | a free account of that provider | no |
| One person, right now, no account | Direct connection | both online at once | no |
| A team with roles, comments, co-editing and different rows per person | **Host from this PC** or `biforge-server.exe` | a computer that stays on | **yes** |

Public reports are signed; private ones are also encrypted for an access key. Static publishing lists the exact tables and columns
that leave the computer and needs your confirmation.

## A team server

1. **Turn on hosting** (File > Host and collaborate), or run `biforge-server.exe` on a computer that stays on. It prints an admin token and
   the certificate fingerprint once. Traffic is TLS with a certificate the server made for itself; invitation links carry the
   fingerprint, so members trust exactly that certificate (no certificate authority, no cost). `--no-tls` is for a network you trust.
2. Create a workspace, publish a report to it (destination "Host from this PC" or "BIForge server"), and invite people: each invitation
   fixes the role (viewer, editor, admin) and the identity (what `USERPRINCIPALNAME()` returns) and works once.
3. Add data roles (a DAX filter per table) and give them to members. Viewers see only their rows.
4. Version history: every upload is kept; "Versions" shows them and "Make current" brings an older one back.
5. A standalone server is managed from the app too: in "Join a server" open "I run this server" and enter its address, the admin token and the fingerprint.

## Edit together and comment

- **Edit together** (editors and administrators; on a direct session the host starts it and guests with the edit role join): changes
  appear in the other windows within a second or two and are merged without conflicts (two people changing different things both
  keep their change; the same property changed by both settles on one value for everybody). The status bar says "Editing together".
  Your undo history ends when someone else's change arrives, so an undo never removes their work. A server report keeps its data on the
  server; the shared project is the model and the report.
- **Comments** (Home > Comments): on the server they are shared by the whole workspace; in a direct session by the people in it; on a
  report that is not shared they stay on this PC. `@name` mentions a person; the mentioned person sees "You are mentioned" in the dialog.
  Threads can be answered and resolved. The author is always the name the server or host knows, never one typed in.
- "Changes made together" lists who changed what and when.

## Scheduled refresh

Publish & Share > your destination > Scheduled refresh. **The dialog always names the place it runs**, and every attempt is in that
place's history with the same words:

| Runs on | Needs to stay on | Reads sources | Good for |
| --- | --- | --- | --- |
| GitHub Actions (GitHub's computers) | nothing of yours | the source files copied into the public repository | GitHub Pages sites |
| This PC (Windows Task Scheduler) | this PC, and you signed in | where they are, with the credentials in Windows Credential Manager | any destination |
| BIForge server (the server computer) | the server | the files copied with the bundle, replaced by same-named files in the report's source folder on the server | reports on a server |

A failed attempt is tried again (default twice); only one refresh of a report runs at a time (a second one shows as "did not start");
a run that finds the same data publishes nothing. On this PC the schedule publishes the report as it was when you turned it on (turn
it on again to use a changed report); if a source gets other columns, the run fails and says to refresh in the app. On a server the
refreshed data sits next to the signed report and is replaced when you publish a new version.

## Limits you should know

See "Residual risks" in [SECURITY_REVIEW.md](SECURITY_REVIEW.md) and the per-item notes in COVERAGE.md. In short: the public relay path of
direct sessions and the Google Drive and OneDrive services were not exercised against the real services; Dropbox was.
