<#
 Runs read-only DAX EVALUATE queries against the local Analysis Services instance that Power BI Desktop starts for
 an open report, and writes the results as JSON. Used by tools/dax-record/record.mjs (do not run by hand unless
 debugging). Nothing is modified in the model; only DEFINE/EVALUATE queries are sent.

 -Requests  JSON file: [{ "id": "...", "query": "EVALUATE ..." }, ...]
 -Out       JSON file to write: { engine, results: [{ id, ok, columns, types, rows, error }] }
 -Port      optional; default: newest msmdsrv.port.txt under the Power BI Desktop workspaces folders
 -AdomdPath optional; default: the ADOMD client library inside the installed Power BI Desktop package
            (loaded in place as a client, never copied)
#>
param(
  [Parameter(Mandatory = $true)][string]$Requests,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$Port = 0,
  [string]$AdomdPath = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Web.Extensions

if (-not $AdomdPath) {
  $pkg = Get-AppxPackage -Name '*PowerBIDesktop*' | Select-Object -First 1
  if (-not $pkg) { throw 'Power BI Desktop package not found; pass -AdomdPath.' }
  $AdomdPath = Join-Path $pkg.InstallLocation 'bin\Microsoft.PowerBI.AdomdClient.dll'
  $version = $pkg.Version
} else { $version = 'unknown' }
$script:binDir = Split-Path $AdomdPath
[System.AppDomain]::CurrentDomain.add_AssemblyResolve({
  param($s, $e)
  $f = Join-Path $script:binDir (($e.Name -split ',')[0] + '.dll')
  if (Test-Path $f) { return [System.Reflection.Assembly]::LoadFrom($f) }
  return $null
})
[void][System.Reflection.Assembly]::LoadFrom($AdomdPath)
$ns = (([System.Reflection.Assembly]::LoadFrom($AdomdPath)).GetTypes() | Where-Object { $_.Name -eq 'AdomdConnection' } | Select-Object -First 1).Namespace

if ($Port -eq 0) {
  $roots = @("$env:LOCALAPPDATA\Microsoft\Power BI Desktop\AnalysisServicesWorkspaces", "$env:USERPROFILE\Microsoft\Power BI Desktop Store App\AnalysisServicesWorkspaces")
  $file = $roots | Where-Object { Test-Path $_ } | ForEach-Object { Get-ChildItem $_ -Recurse -Filter 'msmdsrv.port.txt' -ErrorAction SilentlyContinue } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $file) { throw 'No running Power BI Desktop model found (open the fixture report first).' }
  $Port = [int]((Get-Content $file.FullName -Encoding Unicode -Raw).Trim())
}

$conn = New-Object "$ns.AdomdConnection" "Data Source=localhost:$Port"
$conn.Open()
$cmd = $conn.CreateCommand()
$cmd.CommandText = 'SELECT [CATALOG_NAME] FROM $SYSTEM.DBSCHEMA_CATALOGS'
$r = $cmd.ExecuteReader(); [void]$r.Read(); $catalog = $r.GetString(0); $r.Close()
$conn.ChangeDatabase($catalog)

$ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$ser.MaxJsonLength = [int]::MaxValue

function Convert-Cell($v) {
  if ($v -is [DBNull] -or $null -eq $v) { return $null }
  if ($v -is [double]) {
    if ([double]::IsNaN($v)) { return 'NaN' }
    if ([double]::IsPositiveInfinity($v)) { return 'Infinity' }
    if ([double]::IsNegativeInfinity($v)) { return '-Infinity' }
    return $v
  }
  if ($v -is [decimal]) { return [double]$v }
  if ($v -is [datetime]) { return $v.ToString('yyyy-MM-ddTHH:mm:ss') }
  return $v
}
function Convert-Type([type]$t) {
  switch ($t.FullName) {
    'System.Int64' { 'int' } 'System.Int32' { 'int' } 'System.Double' { 'real' } 'System.Decimal' { 'currency' }
    'System.String' { 'text' } 'System.Boolean' { 'bool' } 'System.DateTime' { 'datetime' } default { 'mixed' }
  }
}

function ToJson($v) {
  if ($null -eq $v) { return "null" }
  if ($v -is [PSObject]) { $v = $v.PSObject.BaseObject }
  if ($v -is [string]) { return $ser.Serialize($v) }
  if ($v -is [bool]) { return $(if ($v) { "true" } else { "false" }) }
  if ($v -is [double] -or $v -is [single]) { return $v.ToString("R", [Globalization.CultureInfo]::InvariantCulture) }
  if ($v -is [int] -or $v -is [long] -or $v -is [decimal]) { return $v.ToString([Globalization.CultureInfo]::InvariantCulture) }
  if ($v -is [System.Collections.IDictionary]) { return "{" + (($v.Keys | ForEach-Object { $ser.Serialize([string]$_) + ":" + (ToJson $v[$_]) }) -join ",") + "}" }
  if ($v -is [System.Collections.IEnumerable]) { return "[" + ((@($v) | ForEach-Object { ToJson $_ }) -join ",") + "]" }
  return $ser.Serialize([string]$v)
}

$reqs = $ser.DeserializeObject((Get-Content $Requests -Raw -Encoding UTF8))
$results = New-Object System.Collections.ArrayList
foreach ($q in $reqs) {
  $res = @{ id = $q['id'] }
  $rd = $null
  try {
    if ($q['query'] -notmatch '^\s*(DEFINE|EVALUATE)') { throw 'Only DEFINE/EVALUATE queries are allowed.' }
    $cmd = $conn.CreateCommand()
    $cmd.CommandText = $q['query']
    $rd = $cmd.ExecuteReader()
    $cols = New-Object System.Collections.ArrayList
    $types = New-Object System.Collections.ArrayList
    for ($i = 0; $i -lt $rd.FieldCount; $i++) { [void]$cols.Add($rd.GetName($i)); [void]$types.Add((Convert-Type $rd.GetFieldType($i))) }
    $rows = New-Object System.Collections.ArrayList
    while ($rd.Read()) {
      $row = New-Object System.Collections.ArrayList
      for ($i = 0; $i -lt $rd.FieldCount; $i++) { [void]$row.Add((Convert-Cell $rd.GetValue($i))) }
      [void]$rows.Add($row)
    }
    $rd.Close()
    $res.ok = $true; $res.columns = $cols; $res.types = $types; $res.rows = $rows
  } catch {
    $res.ok = $false; $res.error = $_.Exception.Message
    if ($rd) { try { $rd.Close() } catch {} }
  }
  [void]$results.Add($res)
}
$conn.Close()
$json = ToJson @{ engine = "local Analysis Services of Power BI Desktop $version"; results = $results }
[System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Ran $($results.Count) queries against localhost:$Port."
