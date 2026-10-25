# MSIX spike: packs the release build into an MSIX and signs it with a throw-away test certificate.
# Nothing is installed and no certificate is trusted by this script. Usage (from the repository root):
#   powershell -File tools/msix/build-msix.ps1 [-Exe target/release/biforge-app.exe] [-Out target/msix] [-Version 0.1.1.0]
# Result: <Out>/BIForge.msix (signed with the test certificate; the Store signs its own copy) and <Out>/test-cert.cer (public half).
param(
  [string]$Exe = "target/release/biforge-app.exe",
  [string]$Out = "target/msix",
  [string]$Version = "0.1.1.0",
  [string]$Publisher = "CN=BIForge Test",
  [switch]$NoSign
)
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$exe = Join-Path $root $Exe
$out = Join-Path $root $Out
if (-not (Test-Path $exe)) { throw "Build the release first: cd app; npx tauri build --no-bundle ($exe is missing)." }
$bin = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\makeappx.exe" | Sort-Object FullName | Select-Object -Last 1
if (-not $bin) { throw "makeappx.exe not found: install the Windows 10/11 SDK." }
$kit = Split-Path $bin.FullName

$stage = Join-Path $out "stage"
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage } # only the staging folder this script made
New-Item -ItemType Directory -Force (Join-Path $stage "Assets") | Out-Null
Copy-Item $exe (Join-Path $stage "biforge-app.exe")
foreach ($a in "StoreLogo.png", "Square44x44Logo.png", "Square150x150Logo.png", "Square71x71Logo.png") {
  Copy-Item (Join-Path $root "app/src-tauri/icons/$a") (Join-Path $stage "Assets/$a")
}
(Get-Content (Join-Path $PSScriptRoot "AppxManifest.xml.in") -Raw).Replace("%VERSION%", $Version).Replace("%PUBLISHER%", $Publisher) |
  Set-Content (Join-Path $stage "AppxManifest.xml") -Encoding UTF8

$pkg = Join-Path $out "BIForge.msix"
& (Join-Path $kit "makeappx.exe") pack /d $stage /p $pkg /o | Write-Host
if ($LASTEXITCODE -ne 0) { throw "makeappx failed" }
if ($NoSign) { Write-Host "Built (unsigned): $pkg"; return }

# a throw-away certificate: created in the current user's store, exported, and removed from the store again
$pw = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$cert = New-SelfSignedCertificate -Type Custom -Subject $Publisher -KeyUsage DigitalSignature -FriendlyName "BIForge MSIX test (delete me)" `
  -CertStoreLocation "Cert:\CurrentUser\My" -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3", "2.5.29.19={text}")
try {
  $pfx = Join-Path $out "test-cert.pfx"
  Export-PfxCertificate -Cert $cert -FilePath $pfx -Password (ConvertTo-SecureString $pw -AsPlainText -Force) | Out-Null
  Export-Certificate -Cert $cert -FilePath (Join-Path $out "test-cert.cer") | Out-Null
  & (Join-Path $kit "signtool.exe") sign /fd SHA256 /f $pfx /p $pw $pkg | Write-Host
  if ($LASTEXITCODE -ne 0) { throw "signtool failed" }
} finally {
  Remove-Item ("Cert:\CurrentUser\My\" + $cert.Thumbprint) -Force
  if (Test-Path (Join-Path $out "test-cert.pfx")) { Remove-Item (Join-Path $out "test-cert.pfx") -Force }
}
Write-Host "Built and signed with a test certificate: $pkg"
