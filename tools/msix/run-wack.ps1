# Runs the Windows App Certification Kit on the MSIX made by build-msix.ps1.
# It needs an ELEVATED PowerShell (appcert.exe asks for it) and trusts the throw-away test certificate for the length of the run:
# the certificate goes into LocalMachine\TrustedPeople and is removed again at the end, also when the kit fails.
# The kit installs the package, starts it, and removes it again; nothing is submitted anywhere.
#   Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','C:\dev\BIForge\tools\msix\run-wack.ps1'
param([string]$Package = "target/msix/BIForge.msix", [string]$Report = "target/msix/wack-report.xml")
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw "Run this script in an elevated (administrator) PowerShell." }
$pkg = Join-Path $root $Package
$rep = Join-Path $root $Report
$cer = Join-Path (Split-Path $pkg) "test-cert.cer"
$kit = "${env:ProgramFiles(x86)}\Windows Kits\10\App Certification Kit\appcert.exe"
if (-not (Test-Path $pkg)) { throw "Build the package first: powershell -File tools/msix/build-msix.ps1" }
$imported = Import-Certificate -FilePath $cer -CertStoreLocation "Cert:\LocalMachine\TrustedPeople"
try {
  & $kit reset | Write-Host
  & $kit test -appxpackagepath $pkg -reportoutputpath $rep | Write-Host
} finally {
  Remove-Item ("Cert:\LocalMachine\TrustedPeople\" + $imported.Thumbprint) -Force
}
# a short summary of what failed
[xml]$x = Get-Content $rep -Raw
$bad = $x.SelectNodes("//TEST") | Where-Object { $_.RESULT.InnerText -match "FAIL|WARN" }
Write-Host ("Overall result: " + $x.REPORT.OVERALL_RESULT)
foreach ($t in $bad) { Write-Host ("{0}: {1} - {2}" -f $t.RESULT.InnerText.Trim(), $t.NAME, ($t.DESCRIPTION)) }
Write-Host "Full report: $rep"
