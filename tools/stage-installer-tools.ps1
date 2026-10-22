# Copies biforge-server.exe and biforge-cli.exe (built with cargo build --release -p biforge-server -p biforge-cli) next to the
# installer definitions, where both installers pick them up as optional components.
param([string]$From = "target/release")
$to = Join-Path $PSScriptRoot "../app/src-tauri/windows/tools"
New-Item -ItemType Directory -Force $to | Out-Null
foreach ($n in "biforge-server.exe", "biforge-cli.exe") { Copy-Item (Join-Path $From $n) $to -Force }
