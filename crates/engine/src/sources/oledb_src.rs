//! OLE DB and Analysis Services (local or on-premises) through Windows PowerShell and `System.Data.OleDb`, which
//! ships with Windows. No Rust crate wraps OLE DB, and COM from Rust would be a large amount of unsafe code, so a
//! short PowerShell script runs the command and writes a CSV file that the engine reads like any CSV.
//!
//! * Secrets never appear on a command line: the connection string, the command and the output path travel in the
//!   environment of the child process; the script itself is passed encoded.
//! * The provider must be installed on this PC in the bitness of PowerShell (64 bit): Microsoft.ACE.OLEDB.*,
//!   MSOLEDBSQL, SQLOLEDB, MSOLAP, and so on. A missing provider is reported with the provider's own message.
//! * Analysis Services falls back to the ADOMD client library when the MSOLAP provider is not registered.
//! * Windows only.

use super::{clean_names, Cell, RawTable};
use crate::creds::CredentialStore;
use crate::error::{EngineError, Result};
use crate::types::SourceSpec;

fn err<E: std::fmt::Display>(e: E) -> EngineError {
    EngineError::Source(format!("OLE DB error: {e}"))
}

/// Header names and rows are written as CSV (invariant culture, ISO dates) by this script.
const SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$inv = [System.Globalization.CultureInfo]::InvariantCulture
function Quote([string]$s) { if ($s -match '[",\r\n]') { return '"' + $s.Replace('"', '""') + '"' } return $s }
# Analysis Services without the MSOLAP provider: the ADOMD client library (the same one Power BI Desktop and SSMS use),
# found in the global assembly cache or in the installed Power BI Desktop package, loaded in place as a client.
function Open-Adomd {
  $conn = ($env:BIFORGE_CONN -replace '^\s*Provider=MSOLAP[^;]*;', '')
  $path = $null
  try { Add-Type -AssemblyName 'Microsoft.AnalysisServices.AdomdClient' } catch { }
  if (-not ('Microsoft.AnalysisServices.AdomdClient.AdomdConnection' -as [type])) {
    $pkg = Get-AppxPackage -Name '*PowerBIDesktop*' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($pkg) {
      $bin = Join-Path $pkg.InstallLocation 'bin'
      $dll = Join-Path $bin 'Microsoft.PowerBI.AdomdClient.dll'
      if (Test-Path $dll) {
        $script:bin = $bin
        [System.AppDomain]::CurrentDomain.add_AssemblyResolve({ param($s, $e) $f = Join-Path $script:bin (($e.Name -split ',')[0] + '.dll'); if (Test-Path $f) { return [System.Reflection.Assembly]::LoadFrom($f) }; return $null })
        $asm = [System.Reflection.Assembly]::LoadFrom($dll)
        $t = $asm.GetTypes() | Where-Object { $_.Name -eq 'AdomdConnection' } | Select-Object -First 1
        if ($t) { return [Activator]::CreateInstance($t, @($conn)) }
      }
    }
    throw "The 'MSOLAP' provider is not registered on the local machine, and no ADOMD client library was found (install the Analysis Services OLE DB provider, or Power BI Desktop)"
  }
  return New-Object Microsoft.AnalysisServices.AdomdClient.AdomdConnection($conn)
}
try {
  try {
    $c = New-Object System.Data.OleDb.OleDbConnection($env:BIFORGE_CONN)
    $c.Open()
  } catch {
    if ($env:BIFORGE_CONN -match '^\s*Provider=MSOLAP' -and $_.Exception.Message -match 'not registered') { $c = Open-Adomd; $c.Open() } else { throw }
  }
  if ($env:BIFORGE_MODE -eq 'tables') {
    $t = $c.GetOleDbSchemaTable([System.Data.OleDb.OleDbSchemaGuid]::Tables, $null)
    $w = New-Object System.IO.StreamWriter($env:BIFORGE_OUT, $false, (New-Object System.Text.UTF8Encoding($false)))
    foreach ($r in $t.Rows) {
      $kind = [string]$r['TABLE_TYPE']
      if ($kind -eq 'TABLE' -or $kind -eq 'VIEW' -or $kind -eq 'ACCESS TABLE') { $w.WriteLine((Quote ([string]$r['TABLE_NAME']))) }
    }
    $w.Close()
  } else {
    $cmd = $c.CreateCommand()
    $cmd.CommandText = $env:BIFORGE_CMD
    $cmd.CommandTimeout = 900
    $rd = $cmd.ExecuteReader()
    $w = New-Object System.IO.StreamWriter($env:BIFORGE_OUT, $false, (New-Object System.Text.UTF8Encoding($false)))
    $names = @(); for ($i = 0; $i -lt $rd.FieldCount; $i++) { $names += (Quote ([string]$rd.GetName($i))) }
    $w.WriteLine(($names -join ','))
    $limit = [int]$env:BIFORGE_LIMIT
    $n = 0
    while ($rd.Read()) {
      $cells = New-Object string[] $rd.FieldCount
      for ($i = 0; $i -lt $rd.FieldCount; $i++) {
        if ($rd.IsDBNull($i)) { $cells[$i] = ''; continue }
        $v = $rd.GetValue($i)
        if ($v -is [DateTime]) { $cells[$i] = $v.ToString('yyyy-MM-dd HH:mm:ss.FFFFFFF', $inv) }
        elseif ($v -is [bool]) { $cells[$i] = $v.ToString().ToLowerInvariant() }
        elseif ($v -is [byte[]]) { $cells[$i] = '' }
        elseif ($v -is [IFormattable]) { $cells[$i] = $v.ToString($null, $inv) }
        else { $cells[$i] = Quote ([string]$v) }
        if ($v -is [string]) { $cells[$i] = Quote $v }
      }
      $w.WriteLine(($cells -join ','))
      $n++
      if ($limit -gt 0 -and $n -ge $limit) { break }
    }
    $w.Close()
    $rd.Close()
  }
  $c.Close()
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 3
}
"#;

/// A connection string must not carry the secret: the password is added from the credential store.
pub fn check_connection(conn: &str) -> Result<()> {
    let low = conn.to_ascii_lowercase().replace(' ', "");
    if low.contains("password=") || low.contains("pwd=") {
        return Err(EngineError::Source("Do not put the password in the connection string: enter it in the Password field, it is kept in Windows Credential Manager.".into()));
    }
    if conn.trim().is_empty() {
        return Err(EngineError::Source("The OLE DB connection string is empty.".into()));
    }
    Ok(())
}

/// Quotes a value for a connection string when it needs it.
fn conn_value(v: &str) -> String {
    if v.contains([';', '"', '\'', '=']) || v.starts_with(' ') || v.ends_with(' ') {
        format!("\"{}\"", v.replace('"', "\"\""))
    } else {
        v.to_string()
    }
}

/// The connection string as sent to the provider.
pub fn full_connection(spec: &SourceSpec, creds: &dyn CredentialStore) -> Result<String> {
    match spec {
        SourceSpec::OleDb { connection, user, .. } => {
            check_connection(connection)?;
            let mut s = connection.trim().trim_end_matches(';').to_string();
            if let Some(u) = user.as_deref().filter(|u| !u.trim().is_empty()) {
                let pw = spec.credential_key().and_then(|k| creds.get(&k).ok().flatten()).unwrap_or_default();
                s.push_str(&format!(";User ID={};Password={}", conn_value(u), conn_value(&pw)));
            }
            Ok(s)
        }
        SourceSpec::AnalysisServices { server, database, user, .. } => {
            if server.trim().is_empty() {
                return Err(EngineError::Source("Enter the Analysis Services server (name, or host:port of a local instance).".into()));
            }
            if server.contains(';') || database.contains(';') {
                return Err(EngineError::Source("The server and database names cannot contain a semicolon.".into()));
            }
            let mut s = format!("Provider=MSOLAP;Data Source={};Initial Catalog={}", conn_value(server.trim()), conn_value(database.trim()));
            match user.as_deref().filter(|u| !u.trim().is_empty()) {
                Some(u) => {
                    let pw = spec.credential_key().and_then(|k| creds.get(&k).ok().flatten()).unwrap_or_default();
                    s.push_str(&format!(";User ID={};Password={}", conn_value(u), conn_value(&pw)));
                }
                None => s.push_str(";Integrated Security=SSPI"),
            }
            Ok(s)
        }
        _ => Err(EngineError::Source("not an OLE DB source".into())),
    }
}

/// The table name as SQL: bracketed when it has anything but letters, digits and underscores.
fn sql_name(n: &str) -> String {
    let n = n.trim();
    if n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.') {
        n.to_string()
    } else {
        format!("[{}]", n.replace(']', "]]"))
    }
}

/// The command the source stands for: its query, or all rows of its table.
pub fn command_text(spec: &SourceSpec) -> Result<String> {
    match spec {
        SourceSpec::OleDb { table, query, .. } => match (query.as_deref().map(str::trim).filter(|q| !q.is_empty()), table.as_deref().map(str::trim).filter(|t| !t.is_empty())) {
            (Some(q), _) => Ok(q.to_string()),
            (None, Some(t)) => Ok(format!("SELECT * FROM {}", sql_name(t))),
            _ => Err(EngineError::Source("Choose a table or write a query.".into())),
        },
        SourceSpec::AnalysisServices { table, query, .. } => match (query.as_deref().map(str::trim).filter(|q| !q.is_empty()), table.as_deref().map(str::trim).filter(|t| !t.is_empty())) {
            (Some(q), _) => Ok(q.to_string()),
            (None, Some(t)) => Ok(format!("EVALUATE '{}'", t.replace('\'', "''"))),
            _ => Err(EngineError::Source("Choose a table, or write a DAX (EVALUATE ...) or MDX query.".into())),
        },
        _ => Err(EngineError::Source("not an OLE DB source".into())),
    }
}

#[cfg(windows)]
fn run(conn: &str, command: &str, mode: &str, limit: Option<usize>) -> Result<Vec<u8>> {
    use std::io::Read;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    let out = std::env::temp_dir().join(format!("biforge-oledb-{}-{}.csv", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)));
    // Windows PowerShell takes UTF-16LE base64 as an encoded command
    let utf16: Vec<u8> = SCRIPT.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    let encoded = base64_encode(&utf16);
    let mut child = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-ExecutionPolicy", "Bypass", "-EncodedCommand", &encoded])
        .env("BIFORGE_CONN", conn)
        .env("BIFORGE_CMD", command)
        .env("BIFORGE_MODE", mode)
        .env("BIFORGE_OUT", &out)
        .env("BIFORGE_LIMIT", limit.unwrap_or(0).to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .spawn()
        .map_err(|e| err(format!("could not start Windows PowerShell: {e}")))?;
    let mut stderr = child.stderr.take().unwrap();
    let mut stdout = child.stdout.take().unwrap();
    let e_thread = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });
    let o_thread = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout.read_to_string(&mut s);
        s
    });
    let end = Instant::now() + Duration::from_secs(20 * 60);
    let status = loop {
        match child.try_wait().map_err(err)? {
            Some(s) => break s,
            None if Instant::now() >= end => {
                let _ = child.kill();
                let _ = std::fs::remove_file(&out);
                return Err(err("the command did not finish in 20 minutes and was stopped"));
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    };
    let stderr_text = e_thread.join().unwrap_or_default();
    let _ = o_thread.join();
    if !status.success() {
        let _ = std::fs::remove_file(&out);
        let msg = stderr_text.lines().find(|l| !l.trim().is_empty() && !l.starts_with("#<") && !l.starts_with("<Objs")).unwrap_or("the provider reported an error").trim().to_string();
        let hint = if msg.contains("not registered") { " Install the provider (and use its 64-bit version), or check its name in the connection string." } else { "" };
        return Err(err(format!("{msg}.{hint}").replace("..", ".")));
    }
    let bytes = std::fs::read(&out).map_err(err);
    let _ = std::fs::remove_file(&out);
    bytes
}

#[cfg(not(windows))]
fn run(_: &str, _: &str, _: &str, _: Option<usize>) -> Result<Vec<u8>> {
    Err(EngineError::Source("OLE DB and Analysis Services are available on Windows only.".into()))
}

fn base64_encode(b: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for c in b.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// All rows (or the first `limit`) of the command as CSV bytes.
pub fn read_csv(spec: &SourceSpec, creds: &dyn CredentialStore, limit: Option<usize>) -> Result<Vec<u8>> {
    let conn = full_connection(spec, creds)?;
    run(&conn, &command_text(spec)?, "rows", limit)
}

pub fn list_tables(spec: &SourceSpec, creds: &dyn CredentialStore) -> Result<Vec<String>> {
    let conn = full_connection(spec, creds)?;
    if matches!(spec, SourceSpec::AnalysisServices { .. }) {
        // a tabular model lists its tables through the schema rowset query of the engine (found against a real Power BI
        // Desktop instance: the model's tables are 'SYSTEM TABLE' rows, next to '$Name' internal ones that are skipped)
        let bytes = run(&conn, "SELECT [TABLE_NAME] FROM $SYSTEM.DBSCHEMA_TABLES WHERE [TABLE_TYPE] = 'TABLE' OR [TABLE_TYPE] = 'SYSTEM TABLE'", "rows", None)?;
        let t = super::dispatch::parse_csv(&bytes);
        return Ok(t.rows.iter().filter_map(|r| r.first().and_then(super::to_text)).filter(|n| !n.starts_with('$')).collect());
    }
    let bytes = run(&conn, "", "tables", None)?;
    let text = String::from_utf8_lossy(&bytes);
    Ok(text.lines().map(|l| l.trim().trim_matches('"').replace("\"\"", "\"")).filter(|l| !l.is_empty()).collect())
}

/// Keeps the engine's CSV reader (types inferred from the text) as the single way a table is built.
pub fn read(spec: &SourceSpec, creds: &dyn CredentialStore, limit: Option<usize>) -> Result<RawTable> {
    let bytes = read_csv(spec, creds, limit)?;
    let mut t = super::dispatch::parse_csv(&bytes);
    t.columns = clean_names(std::mem::take(&mut t.columns));
    // an OLE DB source never has a header problem, but a result with no columns is a mistake in the command
    if t.columns.is_empty() {
        return Err(err("the command returned no columns"));
    }
    let _ = Cell::Null;
    Ok(t)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::creds::MemoryCredentialStore;

    fn ole(conn: &str, user: Option<&str>, table: Option<&str>, query: Option<&str>) -> SourceSpec {
        SourceSpec::OleDb { connection: conn.into(), user: user.map(String::from), table: table.map(String::from), query: query.map(String::from) }
    }

    #[test]
    fn connection_strings_never_carry_the_password_in_the_spec() {
        let c = MemoryCredentialStore::default();
        assert!(full_connection(&ole("Provider=X;Password=a", None, None, None), &c).is_err());
        let s = ole("Provider=SQLOLEDB;Data Source=srv;Initial Catalog=db", Some("ann"), Some("T"), None);
        c.set(&s.credential_key().unwrap(), "p;w\"d").unwrap();
        let full = full_connection(&s, &c).unwrap();
        assert_eq!(full, "Provider=SQLOLEDB;Data Source=srv;Initial Catalog=db;User ID=ann;Password=\"p;w\"\"d\"");
        assert!(!serde_json::to_string(&s).unwrap().contains("p;w"));
    }

    #[test]
    fn analysis_services_connects_with_the_msolap_provider_and_integrated_security_by_default() {
        let c = MemoryCredentialStore::default();
        let a = SourceSpec::AnalysisServices { server: "localhost:51234".into(), database: "Model".into(), user: None, table: Some("Sales".into()), query: None };
        assert_eq!(full_connection(&a, &c).unwrap(), "Provider=MSOLAP;Data Source=localhost:51234;Initial Catalog=Model;Integrated Security=SSPI");
        assert_eq!(command_text(&a).unwrap(), "EVALUATE 'Sales'");
        let q = SourceSpec::AnalysisServices { server: "s".into(), database: "d".into(), user: Some("u".into()), table: None, query: Some("EVALUATE ROW(\"x\", 1)".into()) };
        c.set(&q.credential_key().unwrap(), "pw").unwrap();
        assert!(full_connection(&q, &c).unwrap().ends_with(";User ID=u;Password=pw"));
        assert_eq!(command_text(&q).unwrap(), "EVALUATE ROW(\"x\", 1)");
        assert!(full_connection(&SourceSpec::AnalysisServices { server: "a;b".into(), database: "d".into(), user: None, table: None, query: None }, &c).is_err());
        assert!(command_text(&SourceSpec::AnalysisServices { server: "s".into(), database: "d".into(), user: None, table: None, query: None }).is_err());
    }

    #[test]
    fn table_names_are_bracketed_only_when_needed() {
        assert_eq!(command_text(&ole("x", None, Some("People"), None)).unwrap(), "SELECT * FROM People");
        assert_eq!(command_text(&ole("x", None, Some("Order Details"), None)).unwrap(), "SELECT * FROM [Order Details]");
        assert_eq!(command_text(&ole("x", None, Some("a]b"), None)).unwrap(), "SELECT * FROM [a]]b]");
        assert_eq!(command_text(&ole("x", None, Some("T"), Some("SELECT 1"))).unwrap(), "SELECT 1");
        assert!(command_text(&ole("x", None, None, None)).is_err());
    }

    #[test]
    fn the_encoded_script_is_plain_base64() {
        assert_eq!(base64_encode(b"Man"), "TWFu");
        assert_eq!(base64_encode(b"Ma"), "TWE=");
        assert_eq!(base64_encode(b"M"), "TQ==");
    }
}
