//! Scheduled refresh on this PC.
//!
//! Windows Task Scheduler starts BIForge without a window (`biforge-app.exe --run-scheduled <project folder> <target>`).
//! The run reloads every source of the project into a store of its own (it never touches the store of a window that
//! has the project open), and, when the published data changed, publishes the next version to the destination the
//! schedule belongs to, with the same code a click on Publish uses. Every attempt, with its retries, is written to the
//! history of that destination; a second run of the same job is refused while one is going.
//!
//! What is published is the report as it was when the schedule was turned on (the pruned project kept next to the
//! plan); turning the schedule on again takes the current report. Sources are read where they are, on this PC, with
//! the credentials in Windows Credential Manager. If a source now has other columns than the model, the run fails with
//! that message instead of publishing a report whose model no longer matches.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use biforge_cli::local;
use biforge_engine::Engine;
use biforge_model::project::Project;
use biforge_publish::manifest::IncludedTable;
use biforge_publish::refresh::Schedule;
#[allow(unused_imports)]
use biforge_publish::schedule::{run_job, JobResult, JobStore, Plan, RunRecord, RunsOn, Trigger};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::publish::{PublishService, RunArgs};

fn msg<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPlan {
    pub enabled: bool,
    pub report_name: String,
    pub publisher_name: String,
    pub included: Vec<IncludedTable>,
    /// For this PC the time of day is the local time (Task Scheduler's).
    pub plan: Plan,
    /// Hash of the data that was published last; an unchanged hash means nothing is published.
    #[serde(default)]
    pub last_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskState {
    pub name: String,
    pub exists: bool,
    /// What Task Scheduler says (Ready, Running, Disabled, ...).
    pub status: String,
    pub next_run: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalInfo {
    pub enabled: bool,
    pub plan: Option<Plan>,
    pub runs_on: String,
    pub needs: String,
    pub running: bool,
    pub history: Vec<RunRecord>,
    pub task: Option<TaskState>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnableArgs {
    pub target_id: String,
    pub report_name: String,
    pub publisher_name: String,
    pub included: Vec<IncludedTable>,
    pub plan: Plan,
}

fn job_dir(root: &str, target: &str) -> PathBuf {
    Path::new(root).join(".biforge").join("publish").join("thispc").join(sanitize(target))
}

fn sanitize(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').collect()
}

fn plan_file(root: &str, target: &str) -> PathBuf {
    job_dir(root, target).join("plan.json")
}

fn load_plan(root: &str, target: &str) -> Option<LocalPlan> {
    fs::read(plan_file(root, target)).ok().and_then(|b| serde_json::from_slice(&b).ok())
}

fn save_plan(root: &str, target: &str, p: &LocalPlan) -> Result<(), String> {
    let dir = job_dir(root, target);
    fs::create_dir_all(&dir).map_err(msg)?;
    // the folder ignores itself, like the rest of .biforge
    let ignore = Path::new(root).join(".biforge").join(".gitignore");
    if !ignore.exists() {
        let _ = fs::write(&ignore, "*\n");
    }
    fs::write(plan_file(root, target), serde_json::to_vec_pretty(p).map_err(msg)?).map_err(msg)
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn find_pbip(root: &str) -> Result<PathBuf, String> {
    for e in fs::read_dir(root).map_err(|e| format!("Cannot read the project folder {root}: {e}"))?.flatten() {
        if e.path().extension().and_then(|x| x.to_str()).map(|x| x.eq_ignore_ascii_case("pbip")).unwrap_or(false) {
            return Ok(e.path());
        }
    }
    Err(format!("There is no .pbip project file in {root} any more."))
}

// ------------------------------------------------------------------------------------------------ task scheduler

/// The name of the task in Task Scheduler (a folder "BIForge" holds them all).
pub fn task_name(root: &str, target: &str) -> String {
    let h = biforge_publish::keys::hex(&Sha256::digest(root.to_lowercase().replace('/', "\\").as_bytes())[..4]);
    format!("BIForge\\{h}-{}", sanitize(target))
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// The task definition: the trigger of the plan, "run as soon as possible after a missed start", one instance at a
/// time, no stop on battery, a two hour limit. Runs as the signed-in user, only while that user is signed in.
pub fn task_xml(exe: &str, root: &str, target: &str, description: &str, plan: &Plan, start_date: &str) -> Option<String> {
    let hhmm = format!("{:02}:{:02}:00", plan.at_minute / 60, plan.at_minute % 60);
    let boundary = format!("{start_date}T{hhmm}");
    let trigger = match plan.frequency {
        Schedule::Manual => return None,
        Schedule::Hourly => format!("<TimeTrigger><StartBoundary>{boundary}</StartBoundary><Enabled>true</Enabled><Repetition><Interval>PT1H</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition></TimeTrigger>"),
        Schedule::Daily => format!("<CalendarTrigger><StartBoundary>{boundary}</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>"),
        Schedule::Weekly => format!("<CalendarTrigger><StartBoundary>{boundary}</StartBoundary><Enabled>true</Enabled><ScheduleByWeek><DaysOfWeek><Monday /></DaysOfWeek><WeeksInterval>1</WeeksInterval></ScheduleByWeek></CalendarTrigger>"),
    };
    Some(format!(
        "<?xml version=\"1.0\" encoding=\"UTF-16\"?>\n<Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\"><RegistrationInfo><Description>{}</Description></RegistrationInfo><Triggers>{trigger}</Triggers><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT2H</ExecutionTimeLimit><Enabled>true</Enabled></Settings><Actions Context=\"Author\"><Exec><Command>{}</Command><Arguments>--run-scheduled \"{}\" {}</Arguments></Exec></Actions></Task>",
        xml_escape(description),
        xml_escape(exe),
        xml_escape(root),
        xml_escape(&sanitize(target))
    ))
}

fn utf16le(s: &str) -> Vec<u8> {
    let mut out = vec![0xFF, 0xFE];
    for u in s.encode_utf16() {
        out.extend_from_slice(&u.to_le_bytes());
    }
    out
}

fn schtasks(args: &[&str]) -> Result<String, String> {
    let out = Command::new("schtasks.exe").args(args).output().map_err(|e| format!("Task Scheduler (schtasks.exe) could not be started: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr);
    if out.status.success() {
        Ok(text)
    } else {
        Err(format!("Task Scheduler said: {}", text.trim()))
    }
}

pub fn install_task(exe: &str, root: &str, target: &str, description: &str, plan: &Plan) -> Result<Option<String>, String> {
    let name = task_name(root, target);
    let date = biforge_publish::time::now_rfc3339()[..10].to_string();
    let Some(xml) = task_xml(exe, root, target, description, plan, &date) else {
        let _ = remove_task(root, target);
        return Ok(None);
    };
    let dir = job_dir(root, target);
    fs::create_dir_all(&dir).map_err(msg)?;
    let file = dir.join("task.xml");
    fs::write(&file, utf16le(&xml)).map_err(msg)?;
    let r = schtasks(&["/Create", "/TN", &name, "/XML", &file.to_string_lossy(), "/F"]);
    let _ = fs::remove_file(&file);
    r.map(|_| Some(name))
}

pub fn remove_task(root: &str, target: &str) -> Result<(), String> {
    let name = task_name(root, target);
    match schtasks(&["/Query", "/TN", &name]) {
        Err(_) => Ok(()), // there is none
        Ok(_) => schtasks(&["/Delete", "/TN", &name, "/F"]).map(|_| ()),
    }
}

pub fn task_state(root: &str, target: &str) -> TaskState {
    let name = task_name(root, target);
    match schtasks(&["/Query", "/TN", &name, "/FO", "LIST", "/V"]) {
        Err(_) => TaskState { name, exists: false, status: String::new(), next_run: String::new() },
        Ok(text) => {
            let field = |key: &str| text.lines().find_map(|l| l.strip_prefix(key).map(|v| v.trim().to_string())).unwrap_or_default();
            TaskState { name, exists: true, status: field("Status:"), next_run: field("Next Run Time:") }
        }
    }
}

// ------------------------------------------------------------------------------------------------ the job

fn data_hash(files: &[biforge_publish::package::PackageFile]) -> String {
    let mut parts: Vec<(&str, String)> = files.iter().filter(|f| f.path.starts_with("data/")).map(|f| (f.path.as_str(), biforge_publish::keys::hex(&Sha256::digest(&f.bytes)))).collect();
    parts.sort();
    biforge_publish::keys::hex(&Sha256::digest(parts.iter().map(|(p, h)| format!("{p}:{h}")).collect::<Vec<_>>().join("|").as_bytes()))
}

/// One attempt: reload, check, export, publish when the data changed.
fn attempt(root: &str, target: &str, svc: &PublishService, creds: &dyn biforge_engine::CredentialStore) -> Result<JobResult, String> {
    let mut plan = load_plan(root, target).ok_or("Scheduled refresh on this PC is not set up for this destination.")?;
    if !plan.enabled {
        return Err("Scheduled refresh on this PC is turned off for this destination.".into());
    }
    let full = Project::open(&find_pbip(root)?).map_err(|e| format!("The project cannot be opened: {e}"))?;
    let pruned: Project = serde_json::from_slice(&fs::read(job_dir(root, target).join("project.json")).map_err(|e| format!("The saved copy of the report is missing ({e}). Turn the schedule on again."))?).map_err(|e| format!("The saved copy of the report is damaged ({e}). Turn the schedule on again."))?;

    // a store of its own: a window that has the project open keeps its store
    let store_dir = Path::new(root).join(".biforge");
    fs::create_dir_all(&store_dir).map_err(msg)?;
    let engine = Engine::open(&store_dir.join(format!("thispc-{}.duckdb", sanitize(target)))).map_err(|e| format!("The refresh store cannot be opened: {e}"))?;
    let report = local::refresh_data(&full, &engine, creds);
    if !report.failures.is_empty() {
        return Err(format!("Could not reload: {}", report.failures.iter().map(|(t, e)| format!("table \"{t}\" ({e})")).collect::<Vec<_>>().join("; ")));
    }
    let names: Vec<String> = report.loaded.iter().map(|(t, _)| t.clone()).collect();
    let changed = local::columns_changed(&full, &engine, &names);
    if !changed.is_empty() {
        return Err(format!("The columns of {} changed in the source. Open the report in BIForge, refresh it there, save, and turn the schedule on again.", changed.iter().map(|t| format!("\"{t}\"")).collect::<Vec<_>>().join(", ")));
    }
    let mut included = plan.included.clone();
    let files = svc.collect_files(&pruned, &mut included, &engine)?;
    let hash = data_hash(&files);
    if plan.last_hash.as_deref() == Some(hash.as_str()) {
        return Ok(JobResult { changed: false, message: format!("The sources gave the same data as the last publication ({} tables). Nothing was published.", report.loaded.len()), version: None });
    }
    let out = svc
        .run_with(root, RunArgs { target_id: target.to_string(), report_name: plan.report_name.clone(), publisher_name: plan.publisher_name.clone(), included: included.clone(), confirmed: included.clone(), permissions: vec![], rotate: false }, included, files)
        .map_err(|e| format!("Publishing failed: {e}"))?;
    plan.last_hash = Some(hash);
    save_plan(root, target, &plan)?;
    Ok(JobResult { changed: true, message: format!("Reloaded {} tables and published version {}.", report.loaded.len(), out.state.version), version: Some(out.state.version) })
}

/// Runs the job under its lock with the plan's retries (`retries`: false for a click on Refresh now, which reports at once).
pub fn run(root: &str, target: &str, trigger: Trigger, retries: bool, svc: &PublishService, creds: &dyn biforge_engine::CredentialStore) -> Result<RunRecord, String> {
    let plan = load_plan(root, target).ok_or("Scheduled refresh on this PC is not set up for this destination.")?;
    let mut p = plan.plan.clamped();
    if !retries {
        p.retries = 0;
    }
    let store = JobStore::new(job_dir(root, target));
    let sleep = |s: u64| std::thread::sleep(std::time::Duration::from_secs(s));
    Ok(run_job(&store, RunsOn::ThisPc, trigger, &p, &now, &sleep, &mut |_| attempt(root, target, svc, creds)))
}

pub fn info(root: &str, target: &str) -> LocalInfo {
    let plan = load_plan(root, target);
    let store = JobStore::new(job_dir(root, target));
    LocalInfo {
        enabled: plan.as_ref().map(|p| p.enabled).unwrap_or(false),
        plan: plan.as_ref().map(|p| p.plan),
        runs_on: RunsOn::ThisPc.label().into(),
        needs: RunsOn::ThisPc.needs().into(),
        running: store.running(now()),
        history: store.history(30),
        task: plan.as_ref().map(|_| task_state(root, target)),
    }
}

pub fn enable(root: &str, pruned: &Project, args: EnableArgs, exe: &str, svc: &PublishService) -> Result<LocalInfo, String> {
    if args.included.is_empty() {
        return Err("Choose at least one column to publish.".into());
    }
    if args.publisher_name.trim().is_empty() {
        return Err("Enter the name viewers will see as the publisher.".into());
    }
    // the destination must exist and must have been published once (a schedule updates a published report)
    let targets = svc.targets(root)?;
    let t = targets.iter().find(|t| t.id == args.target_id).ok_or("This destination no longer exists.")?;
    if t.package_id.is_none() {
        return Err("Publish the report to this destination once first; the schedule publishes the next versions.".into());
    }
    let pbip = find_pbip(root)?;
    let full = Project::open(&pbip).map_err(msg)?;
    if local::refreshable(&full).is_empty() {
        return Err("None of the tables has a source that can be reloaded (tables typed in by hand cannot).".into());
    }
    let dir = job_dir(root, &args.target_id);
    fs::create_dir_all(&dir).map_err(msg)?;
    fs::write(dir.join("project.json"), serde_json::to_vec(pruned).map_err(msg)?).map_err(msg)?;
    let previous = load_plan(root, &args.target_id);
    let lp = LocalPlan { enabled: true, report_name: args.report_name, publisher_name: args.publisher_name.trim().to_string(), included: args.included, plan: args.plan.clamped(), last_hash: previous.and_then(|p| p.last_hash) };
    save_plan(root, &args.target_id, &lp)?;
    let description = format!("BIForge: scheduled refresh of \"{}\" to {}", lp.report_name, t.label);
    install_task(exe, root, &args.target_id, &description, &lp.plan)?;
    Ok(info(root, &args.target_id))
}

pub fn disable(root: &str, target: &str) -> Result<LocalInfo, String> {
    remove_task(root, target)?;
    if let Some(mut p) = load_plan(root, target) {
        p.enabled = false;
        save_plan(root, target, &p)?;
    }
    let _ = fs::remove_file(job_dir(root, target).join("project.json"));
    Ok(info(root, target))
}

/// The entry point of `biforge-app.exe --run-scheduled <root> <target>`: no window, exit code 1 when the run failed.
pub fn headless(root: &str, target: &str) -> i32 {
    let svc = PublishService::system();
    let creds = biforge_engine::SystemCredentialStore;
    match run(root, target, Trigger::Scheduled, true, &svc, &creds) {
        Ok(rec) => i32::from(rec.status == biforge_publish::schedule::RunStatus::Failed),
        Err(_) => 1,
    }
}

// ---- Tauri commands ----

#[tauri::command]
pub fn local_refresh_info(root: String, target_id: String) -> LocalInfo {
    info(&root, &target_id)
}

#[tauri::command]
pub async fn local_refresh_enable(s: tauri::State<'_, PublishService>, root: String, project: Project, args: EnableArgs) -> Result<LocalInfo, String> {
    let exe = std::env::current_exe().map_err(msg)?.to_string_lossy().to_string();
    // the service is cheap to share: it holds only handles
    let svc: &PublishService = &s;
    enable(&root, &project, args, &exe, svc)
}

#[tauri::command]
pub fn local_refresh_disable(root: String, target_id: String) -> Result<LocalInfo, String> {
    disable(&root, &target_id)
}

#[tauri::command]
pub async fn local_refresh_run(s: tauri::State<'_, PublishService>, root: String, target_id: String) -> Result<RunRecord, String> {
    let svc: &PublishService = &s;
    let creds = biforge_engine::SystemCredentialStore;
    run(&root, &target_id, Trigger::Manual, false, svc, &creds)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_task_definition_has_the_trigger_the_arguments_and_the_safe_settings() {
        let plan = Plan { frequency: Schedule::Daily, at_minute: 3 * 60 + 5, retries: 2, retry_delay_secs: 300 };
        let x = task_xml("C:\\Apps\\BIForge & Co\\biforge-app.exe", "C:\\Projects\\Sales <1>", "t1x", "refresh \"Sales\"", &plan, "2026-10-22").unwrap();
        assert!(x.contains("<StartBoundary>2026-10-22T03:05:00</StartBoundary>") && x.contains("<DaysInterval>1</DaysInterval>"));
        assert!(x.contains("<Command>C:\\Apps\\BIForge &amp; Co\\biforge-app.exe</Command>"));
        assert!(x.contains("--run-scheduled \"C:\\Projects\\Sales &lt;1&gt;\" t1x"));
        assert!(x.contains("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>") && x.contains("<StartWhenAvailable>true</StartWhenAvailable>"));
        assert!(x.contains("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>"));
        assert!(!x.contains("<Password>") && !x.contains("UserId"), "no credentials in the task");
        let h = task_xml("e", "r", "t", "d", &Plan { frequency: Schedule::Hourly, ..plan }, "2026-10-22").unwrap();
        assert!(h.contains("<Interval>PT1H</Interval>"));
        let w = task_xml("e", "r", "t", "d", &Plan { frequency: Schedule::Weekly, ..plan }, "2026-10-22").unwrap();
        assert!(w.contains("<Monday />"));
        assert!(task_xml("e", "r", "t", "d", &Plan { frequency: Schedule::Manual, ..plan }, "2026-10-22").is_none());
        assert_ne!(task_name("C:\\a", "t"), task_name("C:\\b", "t"));
        assert!(task_name("C:\\a", "t").starts_with("BIForge\\"));
    }

    use biforge_engine::{CredentialStore, MemoryCredentialStore};
    use biforge_model::tmdl::{Document, Expr, Node};
    use biforge_publish::manifest::AccessLevel;
    use biforge_publish::schedule::RunStatus;
    use biforge_publish::targets::Target;
    use std::sync::Arc;

    struct World {
        _dir: tempfile::TempDir,
        root: String,
        csv: PathBuf,
        share: PathBuf,
        svc: PublishService,
        creds: Arc<dyn CredentialStore>,
        project: Project,
    }

    fn world() -> World {
        let dir = tempfile::tempdir().unwrap();
        let root_path = dir.path().join("proj");
        fs::create_dir_all(&root_path).unwrap();
        let root = root_path.to_string_lossy().to_string();
        let csv = dir.path().join("sales.csv");
        fs::write(&csv, "Id,Qty\n1,10\n2,20\n").unwrap();
        let mut p = Project::create_new(&root_path, "Demo").unwrap();
        let mut t = Node::new("table", Some("Sales"));
        t.children.push(Node::new("column", Some("Id")));
        t.children.push(Node::new("column", Some("Qty")));
        let mut a = Node::new("annotation", Some("BIForge.Source"));
        a.default = Some(Expr { text: serde_json::json!({"kind": "csv", "path": csv.to_string_lossy(), "delimiter": null, "header": null}).to_string(), verbatim: false });
        t.children.push(a);
        p.model.tmdl.insert("tables/Sales.tmdl".into(), Document { nodes: vec![t] });
        p.save(&root_path).unwrap();
        let creds: Arc<dyn CredentialStore> = Arc::new(MemoryCredentialStore::default());
        let svc = PublishService::new(creds.clone(), dir.path().join("cache"));
        let share = dir.path().join("share");
        fs::create_dir_all(&share).unwrap();
        let mut target = Target::new("t1", "local-folder", "Shared folder", AccessLevel::Public);
        target.settings.insert("folder".into(), share.to_string_lossy().to_string());
        svc.put_target(&root, target).unwrap();
        // the first publication is made by hand, as a person would
        let engine = Engine::in_memory().unwrap();
        let report = local::refresh_data(&p, &engine, creds.as_ref());
        assert!(report.failures.is_empty());
        let mut included = vec![IncludedTable { table: "Sales".into(), columns: vec!["Id".into(), "Qty".into()], data_file: String::new() }];
        let files = svc.collect_files(&p, &mut included, &engine).unwrap();
        let args = RunArgs { target_id: "t1".into(), report_name: "Demo".into(), publisher_name: "Me".into(), included: included.clone(), confirmed: included.clone(), permissions: vec![], rotate: false };
        let out = svc.run_with(&root, args, included, files).unwrap();
        assert_eq!(out.state.version, 1);
        World { _dir: dir, root, csv, share, svc, creds, project: p }
    }

    fn enable_manual(w: &World) {
        let included = vec![IncludedTable { table: "Sales".into(), columns: vec!["Id".into(), "Qty".into()], data_file: String::new() }];
        // Manual: no task is registered with Windows, so this test changes nothing outside its folder
        let args = EnableArgs { target_id: "t1".into(), report_name: "Demo".into(), publisher_name: "Me".into(), included, plan: Plan { frequency: Schedule::Manual, at_minute: 180, retries: 1, retry_delay_secs: 1 } };
        let info = enable(&w.root, &w.project, args, "biforge-app.exe", &w.svc).unwrap();
        assert!(info.enabled && info.runs_on.contains("This PC") && info.needs.contains("must be on"));
    }

    fn versions_in(share: &Path) -> Vec<u64> {
        let feed = fs::read_dir(share).unwrap().flatten().filter(|e| e.path().extension().map(|x| x == "biforge").unwrap_or(false)).count();
        vec![feed as u64]
    }

    #[test]
    fn a_run_on_this_pc_reloads_publishes_only_when_the_data_changed_and_keeps_a_history() {
        let w = world();
        // a schedule needs a published destination, a source it can reload and a publisher name
        let included = vec![IncludedTable { table: "Sales".into(), columns: vec!["Id".into()], data_file: String::new() }];
        let bad = EnableArgs { target_id: "nope".into(), report_name: "Demo".into(), publisher_name: "Me".into(), included: included.clone(), plan: Plan::default() };
        assert!(enable(&w.root, &w.project, bad, "x.exe", &w.svc).unwrap_err().contains("no longer exists"));
        let nobody = EnableArgs { target_id: "t1".into(), report_name: "Demo".into(), publisher_name: " ".into(), included, plan: Plan::default() };
        assert!(enable(&w.root, &w.project, nobody, "x.exe", &w.svc).unwrap_err().contains("publisher"));
        enable_manual(&w);

        // first run: the data equals what was published by hand, but the hash is new, so it publishes version 2
        let r1 = run(&w.root, "t1", Trigger::Manual, false, &w.svc, w.creds.as_ref()).unwrap();
        assert_eq!((r1.status, r1.version, r1.runs_on), (RunStatus::Refreshed, Some(2), RunsOn::ThisPc), "{r1:?}");
        // nothing changed: nothing is published
        let r2 = run(&w.root, "t1", Trigger::Manual, false, &w.svc, w.creds.as_ref()).unwrap();
        assert_eq!((r2.status, r2.version), (RunStatus::Unchanged, None), "{r2:?}");
        // the source got a row: version 3, and the package in the destination really holds it
        fs::write(&w.csv, "Id,Qty\n1,10\n2,20\n3,30\n").unwrap();
        let r3 = run(&w.root, "t1", Trigger::Scheduled, true, &w.svc, w.creds.as_ref()).unwrap();
        assert_eq!((r3.status, r3.version, r3.trigger), (RunStatus::Refreshed, Some(3), Trigger::Scheduled), "{r3:?}");
        let st = w.svc.status(&w.root, "t1").unwrap().unwrap();
        assert_eq!(st.version, 3);
        assert!(!versions_in(&w.share).is_empty());

        // the columns of the source changed: the run fails with a message that says what to do, and publishes nothing
        fs::write(&w.csv, "Id,Qty,Region\n1,10,E\n").unwrap();
        let r4 = run(&w.root, "t1", Trigger::Manual, false, &w.svc, w.creds.as_ref()).unwrap();
        assert_eq!(r4.status, RunStatus::Failed);
        assert!(r4.message.contains("columns of \"Sales\" changed"), "{}", r4.message);
        assert_eq!(w.svc.status(&w.root, "t1").unwrap().unwrap().version, 3);
        // a missing file fails too; with retries every attempt is in the history
        fs::remove_file(&w.csv).unwrap();
        let r5 = run(&w.root, "t1", Trigger::Scheduled, true, &w.svc, w.creds.as_ref()).unwrap();
        assert_eq!((r5.status, r5.attempt), (RunStatus::Failed, 2));
        let h = info(&w.root, "t1").history;
        assert_eq!(h.iter().filter(|r| r.trigger == Trigger::Scheduled && r.status == RunStatus::Failed).count(), 2);
        assert!(h.iter().all(|r| r.runs_on == RunsOn::ThisPc));

        // one run at a time
        fs::write(w.root.clone() + "/.biforge/publish/thispc/t1/running.lock", now().to_string()).unwrap();
        let r6 = run(&w.root, "t1", Trigger::Manual, false, &w.svc, w.creds.as_ref()).unwrap();
        assert_eq!(r6.status, RunStatus::Skipped);
        assert!(info(&w.root, "t1").running);
        fs::remove_file(w.root.clone() + "/.biforge/publish/thispc/t1/running.lock").unwrap();

        // turned off: runs are refused
        let off = disable(&w.root, "t1").unwrap();
        assert!(!off.enabled);
        fs::write(&w.csv, "Id,Qty\n1,1\n").unwrap();
        assert_eq!(run(&w.root, "t1", Trigger::Manual, false, &w.svc, w.creds.as_ref()).unwrap().status, RunStatus::Failed);
    }

    #[test]
    fn the_task_is_registered_with_windows_task_scheduler_and_removed_again() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let target = format!("test{}", biforge_publish::keys::hex(&biforge_publish::keys::random_bytes::<4>()));
        let plan = Plan { frequency: Schedule::Daily, at_minute: 3 * 60, retries: 1, retry_delay_secs: 60 };
        let name = install_task("C:\\Windows\\System32\\notepad.exe", &root, &target, "BIForge test task (deleted by the test)", &plan).expect("Task Scheduler accepts the definition");
        // whatever happens, the test task is removed
        let result = std::panic::catch_unwind(|| {
            let st = task_state(&root, &target);
            assert!(st.exists, "{st:?}");
            assert_eq!(Some(st.name.clone()), name);
            assert!(st.next_run.contains("03:00") || st.next_run.contains("3:00"), "{st:?}");
        });
        remove_task(&root, &target).unwrap();
        assert!(!task_state(&root, &target).exists);
        result.unwrap();
    }
}
