# MSIX spike (2026-10-25)

Goal: find out what a Microsoft Store build of BIForge needs. Nothing was submitted, no account was used, nothing was installed.

## What was built and checked

* `tools/msix/build-msix.ps1` packs the release build (`npx tauri build --no-bundle`, 7 min 10 s to compile, `biforge-app.exe` 75.9 MB) with the manifest `tools/msix/AppxManifest.xml.in` into `target/msix/BIForge.msix` (30 MB, x64, `Windows.FullTrustApplication`, capability `runFullTrust`, the `biforge:` protocol and the `.biforge` file type declared). It signs with a throw-away certificate that it creates in the user's store, exports and removes again.
* `makeappx pack` accepted the manifest and package (its schema validation passed). `signtool verify /pa` reports "terminated in a root certificate which is not trusted", as expected for a test certificate.
* The executable has ASLR, high-entropy ASLR, DEP and terminal-server awareness; **Control Flow Guard is off**; it has no Authenticode signature; its manifest does not ask for administrator rights.
* This PC: Windows 11 Home 26200, WebView2 runtime 155 installed, **Smart App Control is off**, so the Smart App Control test of the plan could not be made here (it needs a PC where it is on, which cannot be switched on again without a reset).

## What could not be done: the Windows App Certification Kit

`appcert.exe test` stops with "The requested operation requires elevation", and a self-signed package also needs its certificate trusted on the machine (LocalMachine\TrustedPeople) before the kit can install it. Both are changes to the PC that only the owner should make.

**Owner step (about 10 minutes, nothing leaves the PC):** open the Start menu, type `PowerShell`, right-click "Windows PowerShell", choose "Run as administrator", answer Yes, then paste:

```powershell
cd C:\dev\BIForge
powershell -NoProfile -ExecutionPolicy Bypass -File tools\msix\run-wack.ps1
```

The script trusts the test certificate only for the run (and removes it again), runs the kit, and prints the failed and warning tests; the full report is `target\msix\wack-report.xml`. Tell me what it prints and I will fix what is in BIForge's hands.

## What I expect to be a problem (not verified)

1. **Self-update must go.** The Tauri updater downloads and runs a new installer; Store apps update only through the Store. A Store build compiles the updater plugin out (a Cargo feature, for example `store`), hides About > "Check for updates" and the update dialog, and stops the startup check (`updateCommands.ts`, `Dialogs.tsx`, `App.tsx`).
2. **`runFullTrust` is a restricted capability.** The Store review asks why; the answer is "a desktop application that reads and writes the user's project folders and local data sources".
3. **Registration of `biforge://` and `.biforge`.** In the package they come from the manifest (done in the template); the installer-time registration of the NSIS/MSI builds does not apply. The app already reads the link or file from the command line, which is how a packaged activation arrives.
4. **Per-user data moves.** A packaged app's writes to `%APPDATA%` / `%LOCALAPPDATA%` (including the WebView2 profile that holds the interface settings and the recent list) are redirected into the package's own folder and removed when the app is uninstalled. Settings of an NSIS install are not visible to the packaged app. Project folders the user picks are real paths and unaffected; Windows Credential Manager works for full-trust packages.
5. **WebView2.** Windows 11 has the Evergreen runtime. A Store package cannot run the bootstrapper; for Windows 10 the options are to require the runtime (show a link when it is missing) or ship the fixed-version runtime (about 150 MB).
6. **Version.** The Store wants the fourth number to be 0 and the first not to be 0 (check the current Partner Center rule before submitting); BIForge is 0.1.1 today.
7. **Identity.** The Store replaces `Publisher` and fixes `Name` to the reserved product name; both come from Partner Center, not from the manifest template.
8. **Other tests that may complain:** missing scaled tile assets (only single files are packed), Control Flow Guard (enable `-C control-flow-guard` for the release profile), the unsigned `biforge-cli.exe` and `biforge-server.exe` (not in the package: they would need separate execution aliases), Windows PowerShell started as a child process by the OLE DB connector and the optional Python and R script sources (allowed for full trust, to be described in the certification notes).

## Cost

Microsoft announced on 2025-09-10 that registering as an individual developer is free (no credit card); some older pages still show a one-time $19 fee and $99 for companies. Check the registration page when the owner decides, because the project rule is zero cost and no payment card ever: only a free individual registration is acceptable.
Sources: <https://blogs.windows.com/windowsdeveloper/2025/09/10/free-developer-registration-for-individual-developers-on-microsoft-store/>, <https://developer.microsoft.com/en-us/store/register>.

## Next steps

1. Owner: run the WACK step above and send the result.
2. Add the `store` Cargo feature (no updater) and a CI job that builds the MSIX unsigned for the Store (the Store signs it itself).
3. Decide Windows 10 support (WebView2) and the version number scheme.
4. Only then, and only if the registration is free, create the individual Partner Center account (owner action) and reserve the name.

## Result of the Windows App Certification Kit (reported by the owner, 2026-10-25)

**Overall PASS.** One test was flagged: **Blocked executables** ("references to process launch APIs and blocked executables"). The test certificate is confirmed removed from LocalMachine\TrustedPeople.

The full report (`target\msix\wack-report.xml`) was deleted when `target/` was cleaned for disk space, so the exact strings the kit matched could not be read back. The list below comes from the source instead: every place where BIForge starts another program (`Command::new`; there is no `ShellExecute` or `CreateProcess` call outside the standard library). To get the kit's own list, rebuild with `tools/msix/build-msix.ps1` and run `tools/msix/run-wack.ps1` again, then the script now writes the report to `docs/msix-wack-report.xml`, outside `target/`, so a clean does not delete it.

| # | Call site | Starts | Why | Proposal |
| --- | --- | --- | --- | --- |
| 1 | `crates/engine/src/sources/oledb_src.rs:193` | `powershell.exe -EncodedCommand ...` | OLE DB and Analysis Services connectors run a short script with `System.Data.OleDb` / the ADOMD client; PowerShell is on the kit's blocked list | **Remove from the Store build**: a Cargo feature `store` compiles the two connectors out (the NSIS/MSI builds keep them). A direct OLE DB implementation needs COM bindings (`windows` crate: `IDBInitialize`, `ICommand`, rowsets) for every provider and cannot host the .NET ADOMD library, so Analysis Services would still need another route; judged too large for the gain. **Alternative: keep and justify** (text below) if the Store review accepts it. |
| 2 | `app/src-tauri/src/commands.rs:175` | `rundll32.exe url.dll,FileProtocolHandler <url>` | opens an http(s) address in the default browser | **Remove (done)**: replaced by the `open` crate, which calls `ShellExecuteW` in-process. |
| 3 | `app/src-tauri/src/scheduled.rs:161` | `schtasks.exe` | scheduled refresh registers a Windows task that runs `biforge-app.exe` | **Remove from the Store build** (same `store` feature): a packaged app cannot register a task that starts its own package path reliably (the path changes on every update). Direct alternative for the installer builds: the Task Scheduler COM API (`ITaskService`), no executable. |
| 4 | `crates/engine/src/sources/script_src.rs:38,167` | the user's `python.exe` / `Rscript.exe` | Python and R script sources | **Keep and justify**: the interpreter is the user's own, found on their PC, started only after a confirmation box, with a timeout; BIForge ships none. |

### Justification for the certification notes (items kept)

> BIForge is a desktop application (`runFullTrust`) that reads and writes local project folders. (a) The optional Python and R data sources run the interpreter that the user installed, only after the user confirmed the script in a dialog; BIForge ships no interpreter and the script text is the user's own. (b) [only if item 1 is kept] The optional OLE DB / Analysis Services data sources use Windows PowerShell with `System.Data.OleDb` to read from providers installed on the user's PC, with a fixed script, a connection string the user typed and no network access of its own. Neither is started without an explicit user action.
