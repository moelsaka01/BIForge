//! Python and R script sources. BIForge runs the user's own interpreter (it ships none): the script runs, and every
//! pandas DataFrame (Python) or data.frame (R) it leaves in its global scope becomes a table, handed over as CSV
//! files in a temporary folder. When no interpreter is found the message says exactly what to install.
//!
//! Security: a script runs with the user's own rights, like any program they start. The script text is in the project
//! (as the M `Python.Execute` / `R.Execute` text) and is shown before it runs for the first time in the dialog.

use super::{clean_names, RawTable};
use crate::error::{EngineError, Result};
use crate::types::SourceSpec;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn err<E: std::fmt::Display>(e: E) -> EngineError {
    EngineError::Source(format!("Script error: {e}"))
}

pub fn guidance(language: &str) -> String {
    if language == "r" {
        "BIForge did not find R on this computer. Install R from https://cran.r-project.org/bin/windows/base/ (free), then either let BIForge find it (it looks on the PATH and in C:\\Program Files\\R) or set the R home directory in File > Options and settings > R scripting. A script produces tables from data.frame variables.".into()
    } else {
        "BIForge did not find Python on this computer. Install Python 3 from https://www.python.org/downloads/windows/ (free; the Microsoft Store shortcut that opens when you type python is not a Python), then install pandas with `python -m pip install pandas`. BIForge looks on the PATH and in the usual install folders; you can also set the Python home directory in File > Options and settings > Python scripting. A script produces tables from pandas DataFrame variables.".into()
    }
}

/// True when the output of `--version` is a real interpreter (the Windows Store stub prints a different message).
pub fn looks_like_interpreter(language: &str, output: &str) -> bool {
    let o = output.trim();
    if language == "r" {
        o.contains("R scripting front-end") || o.starts_with("R version") || o.contains("Rscript")
    } else {
        o.starts_with("Python 3")
    }
}

fn works(language: &str, exe: &Path) -> bool {
    let mut c = Command::new(exe);
    c.arg("--version").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    let Ok(mut child) = c.spawn() else { return false };
    let end = Instant::now() + Duration::from_secs(10);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < end => std::thread::sleep(Duration::from_millis(30)),
            _ => {
                let _ = child.kill();
                return false;
            }
        }
    }
    let Ok(out) = child.wait_with_output() else { return false };
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    out.status.success() && looks_like_interpreter(language, &text)
}

fn candidates(language: &str, home: Option<&str>) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = Vec::new();
    let exe = if language == "r" { "Rscript.exe" } else { "python.exe" };
    if let Some(h) = home.map(str::trim).filter(|h| !h.is_empty()) {
        let h = PathBuf::from(h);
        if language == "r" {
            v.push(h.join("bin").join("x64").join(exe));
            v.push(h.join("bin").join(exe));
        }
        v.push(h.join(exe));
    }
    if let Some(path) = std::env::var_os("PATH") {
        for d in std::env::split_paths(&path) {
            if language == "python" {
                v.push(d.join("python3.exe"));
            }
            v.push(d.join(exe));
        }
    }
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(l) = std::env::var_os("LOCALAPPDATA") {
        roots.push(PathBuf::from(l).join("Programs").join("Python"));
    }
    roots.push(PathBuf::from(r"C:\Program Files\Python"));
    roots.push(PathBuf::from(r"C:\Program Files\R"));
    roots.push(PathBuf::from("C:\\"));
    for r in roots {
        if let Ok(rd) = std::fs::read_dir(&r) {
            let mut dirs: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
            dirs.sort();
            dirs.reverse(); // newest version first
            for d in dirs {
                let name = d.file_name().and_then(|n| n.to_str()).unwrap_or("").to_ascii_lowercase();
                if language == "python" && (name.starts_with("python3") || name.starts_with("python-3")) {
                    v.push(d.join(exe));
                }
                if language == "r" && name.starts_with("r-") {
                    v.push(d.join("bin").join("x64").join(exe));
                    v.push(d.join("bin").join(exe));
                }
            }
        }
    }
    v
}

/// Finds a working interpreter or says what to install.
pub fn find_interpreter(language: &str, home: Option<&str>) -> Result<PathBuf> {
    for c in candidates(language, home) {
        if c.is_file() && works(language, &c) {
            return Ok(c);
        }
    }
    Err(EngineError::Source(guidance(language)))
}

const PY_WRAPPER: &str = r#"import os, sys
out = os.environ["BIFORGE_OUT"]
g = {"__name__": "__main__"}
with open(os.environ["BIFORGE_SCRIPT"], encoding="utf-8") as f:
    exec(compile(f.read(), "script", "exec"), g)
try:
    import pandas as pd
except ImportError:
    sys.stderr.write("The pandas package is not installed. Run: python -m pip install pandas\n")
    sys.exit(3)
names = []
for k, v in list(g.items()):
    if isinstance(v, pd.DataFrame) and not k.startswith("_"):
        v.to_csv(os.path.join(out, k + ".csv"), index=False, encoding="utf-8")
        names.append(k)
with open(os.path.join(out, "_tables.txt"), "w", encoding="utf-8") as f:
    f.write("\n".join(names))
"#;

const R_WRAPPER: &str = r#"out <- Sys.getenv("BIFORGE_OUT")
env <- new.env()
sys.source(Sys.getenv("BIFORGE_SCRIPT"), envir = env)
done <- character()
for (n in ls(env)) {
  v <- get(n, envir = env)
  if (is.data.frame(v)) {
    write.csv(v, file.path(out, paste0(n, ".csv")), row.names = FALSE, fileEncoding = "UTF-8", na = "")
    done <- c(done, n)
  }
}
writeLines(done, file.path(out, "_tables.txt"))
"#;

/// Runs the script with `interpreter`; returns the tables it produced, in the order the script defined them.
pub fn run(interpreter: &Path, language: &str, code: &str, timeout: Duration) -> Result<Vec<(String, RawTable)>> {
    let dir = std::env::temp_dir().join(format!("biforge-script-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)));
    std::fs::create_dir_all(&dir).map_err(err)?;
    let result = run_in(&dir, interpreter, language, code, timeout);
    let _ = std::fs::remove_dir_all(&dir);
    result
}

fn run_in(dir: &Path, interpreter: &Path, language: &str, code: &str, timeout: Duration) -> Result<Vec<(String, RawTable)>> {
    use std::io::Read;
    let (script_name, wrapper_name, wrapper) = if language == "r" { ("script.R", "run.R", R_WRAPPER) } else { ("script.py", "run.py", PY_WRAPPER) };
    std::fs::write(dir.join(script_name), code).map_err(err)?;
    std::fs::write(dir.join(wrapper_name), wrapper).map_err(err)?;
    let out = dir.join("out");
    std::fs::create_dir_all(&out).map_err(err)?;
    let mut cmd = Command::new(interpreter);
    if language == "r" {
        cmd.arg("--vanilla");
    }
    cmd.arg(dir.join(wrapper_name))
        .current_dir(dir)
        .env("BIFORGE_SCRIPT", dir.join(script_name))
        .env("BIFORGE_OUT", &out)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().map_err(|e| err(format!("could not start {}: {e}", interpreter.display())))?;
    let mut so = child.stdout.take().unwrap();
    let mut se = child.stderr.take().unwrap();
    let t_out = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = so.read_to_string(&mut s);
        s
    });
    let t_err = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = se.read_to_string(&mut s);
        s
    });
    let end = Instant::now() + timeout;
    let status = loop {
        match child.try_wait().map_err(err)? {
            Some(s) => break s,
            None if Instant::now() >= end => {
                let _ = child.kill();
                return Err(err(format!("the script did not finish in {} and was stopped", if timeout.as_secs() >= 120 { format!("{} minutes", timeout.as_secs() / 60) } else { format!("{} seconds", timeout.as_secs()) })));
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    };
    let _ = t_out.join();
    let stderr = t_err.join().unwrap_or_default();
    if !status.success() {
        // the interpreter's own message, last lines first (a traceback ends with the error)
        let lines: Vec<&str> = stderr.lines().filter(|l| !l.trim().is_empty()).collect();
        let tail = lines.iter().rev().take(6).rev().cloned().collect::<Vec<_>>().join(" | ");
        return Err(err(if tail.is_empty() { format!("the script ended with an error ({status})") } else { tail }));
    }
    let names = std::fs::read_to_string(out.join("_tables.txt")).unwrap_or_default();
    let mut tables = Vec::new();
    for n in names.lines().map(str::trim).filter(|n| !n.is_empty()) {
        if !n.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '.') {
            continue;
        }
        let bytes = std::fs::read(out.join(format!("{n}.csv"))).map_err(err)?;
        let mut t = super::dispatch::parse_csv(&bytes);
        t.columns = clean_names(std::mem::take(&mut t.columns));
        tables.push((n.to_string(), t));
    }
    Ok(tables)
}

fn timeout_of(home_options_minutes: Option<u64>) -> Duration {
    Duration::from_secs(home_options_minutes.unwrap_or(30).clamp(1, 600) * 60)
}

fn parts(spec: &SourceSpec) -> Result<(&str, &str, Option<&str>, Option<&str>)> {
    match spec {
        SourceSpec::Script { language, code, table, home } => {
            if language != "python" && language != "r" {
                return Err(EngineError::Source(format!("Unknown script language \"{language}\" (python or r).")));
            }
            if code.trim().is_empty() {
                return Err(EngineError::Source("The script is empty.".into()));
            }
            Ok((language, code, table.as_deref(), home.as_deref()))
        }
        _ => Err(EngineError::Source("not a script source".into())),
    }
}

/// The tables the script produces (the navigator list).
pub fn choices(spec: &SourceSpec) -> Result<Vec<String>> {
    let (lang, code, _, home) = parts(spec)?;
    let exe = find_interpreter(lang, home)?;
    Ok(run(&exe, lang, code, timeout_of(None))?.into_iter().map(|(n, _)| n).collect())
}

pub fn read(spec: &SourceSpec) -> Result<RawTable> {
    let (lang, code, table, home) = parts(spec)?;
    let exe = find_interpreter(lang, home)?;
    let mut tables = run(&exe, lang, code, timeout_of(None))?;
    if tables.is_empty() {
        return Err(EngineError::Source(if lang == "r" { "The script made no data.frame. Assign the result to a variable, for example `df <- data.frame(a = 1:3)`." } else { "The script made no pandas DataFrame. Assign the result to a variable, for example `df = pandas.DataFrame({\"a\": [1, 2, 3]})`." }.into()));
    }
    match table.map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) => tables.into_iter().find(|(n, _)| n == t).map(|(_, r)| r).ok_or_else(|| EngineError::Source(format!("The script made no table named \"{t}\"."))),
        None => Ok(tables.remove(0).1),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_store_stub_and_other_noise_are_not_interpreters() {
        assert!(looks_like_interpreter("python", "Python 3.12.4\n"));
        assert!(!looks_like_interpreter("python", "Python was not found; run without arguments to install from the Microsoft Store"));
        assert!(!looks_like_interpreter("python", "Python 2.7.18"));
        assert!(looks_like_interpreter("r", "R scripting front-end version 4.4.1 (2024-06-14)"));
        assert!(!looks_like_interpreter("r", ""));
    }

    #[test]
    fn guidance_names_where_to_get_the_interpreter_and_the_options_page() {
        let p = guidance("python");
        assert!(p.contains("python.org") && p.contains("pandas") && p.contains("Python scripting") && p.contains("Microsoft Store"));
        let r = guidance("r");
        assert!(r.contains("cran.r-project.org") && r.contains("R scripting"));
    }

    #[test]
    fn a_home_that_has_no_interpreter_is_not_taken_for_one() {
        let d = tempfile::tempdir().unwrap();
        // an empty folder, and a file that is not a program
        std::fs::write(d.path().join("python.exe"), b"not a program").unwrap();
        let found = find_interpreter("python", Some(&d.path().to_string_lossy())).ok();
        // another real Python elsewhere on this PC may be found; the fake in the home folder never is
        assert!(found.is_none_or(|p| !p.starts_with(d.path())));
    }

    #[test]
    fn script_sources_validate_before_anything_runs() {
        let s = |lang: &str, code: &str| SourceSpec::Script { language: lang.into(), code: code.into(), table: None, home: None };
        assert!(read(&s("perl", "x")).unwrap_err().to_string().contains("Unknown script language"));
        assert!(read(&s("python", "  ")).unwrap_err().to_string().contains("empty"));
    }

    /// The runner with a stand-in interpreter (a batch file that writes what the wrapper would): files in, tables out,
    /// the order of the tables, error text, and the timeout. The wrappers themselves need a real Python or R.
    #[cfg(windows)]
    #[test]
    fn the_runner_hands_the_script_over_collects_tables_and_reports_failures() {
        let d = tempfile::tempdir().unwrap();
        let fake = d.path().join("fakepython.cmd");
        std::fs::write(
            &fake,
            "@echo off\r\nif not exist \"%BIFORGE_SCRIPT%\" exit /b 5\r\nfindstr /c:\"fail please\" \"%BIFORGE_SCRIPT%\" >nul && (echo Traceback 1>&2 & echo ValueError: asked to fail 1>&2 & exit /b 1)\r\nfindstr /c:\"sleep please\" \"%BIFORGE_SCRIPT%\" >nul && (ping -n 30 127.0.0.1 >nul)\r\n> \"%BIFORGE_OUT%\\second.csv\" echo b\r\n>> \"%BIFORGE_OUT%\\second.csv\" echo 9\r\n> \"%BIFORGE_OUT%\\first.csv\" echo a,name\r\n>> \"%BIFORGE_OUT%\\first.csv\" echo 1,Ann\r\n>> \"%BIFORGE_OUT%\\first.csv\" echo 2,Bo\r\n> \"%BIFORGE_OUT%\\_tables.txt\" echo first\r\n>> \"%BIFORGE_OUT%\\_tables.txt\" echo second\r\n",
        )
        .unwrap();
        let t = run(&fake, "python", "df = 1", Duration::from_secs(30)).unwrap();
        assert_eq!(t.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(), ["first", "second"]);
        assert_eq!(t[0].1.columns, ["a", "name"]);
        assert_eq!(t[0].1.rows.len(), 2);
        let e = run(&fake, "python", "fail please", Duration::from_secs(30)).unwrap_err().to_string();
        assert!(e.contains("ValueError: asked to fail"), "{e}");
        let e = run(&fake, "python", "sleep please", Duration::from_secs(1)).unwrap_err().to_string();
        assert!(e.contains("did not finish"), "{e}");
        assert!(run(&d.path().join("missing.exe"), "python", "x", Duration::from_secs(5)).is_err());
    }
}
