//! What every place that refreshes a report on a schedule has in common: when a run is due, one run at a time per job
//! (a second run is refused while one is going), retries after a failure, and a history of what happened and where.
//!
//! A refresh runs in one of three places and the history always says which one:
//! * **GitHub Actions**: a workflow in the site's repository on GitHub's computers (its runs are in GitHub's own list).
//! * **This PC**: Windows Task Scheduler starts BIForge without a window; the PC must be on and the user signed in.
//! * **BIForge server**: the server computer runs the job; it must stay on.

use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::refresh::Schedule;

/// Where a refresh runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunsOn {
    GithubActions,
    ThisPc,
    Server,
}

impl RunsOn {
    /// The words the app shows next to every refresh.
    pub fn label(self) -> &'static str {
        match self {
            RunsOn::GithubActions => "GitHub Actions (on GitHub's computers)",
            RunsOn::ThisPc => "This PC (Windows Task Scheduler)",
            RunsOn::Server => "BIForge server (the server computer)",
        }
    }
    /// What must be on for it to run.
    pub fn needs(self) -> &'static str {
        match self {
            RunsOn::GithubActions => "Nothing on your side has to stay on. The whole source files are copied into the public repository.",
            RunsOn::ThisPc => "This PC must be on and you must be signed in at the scheduled time. The sources are read where they are.",
            RunsOn::Server => "The server must stay on. It reads the files in the report's source folder on the server and the web sources.",
        }
    }
}

/// When and how often a job runs, and how it retries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub frequency: Schedule,
    /// Minute of the day (0 to 1439, UTC) at which a daily or weekly run starts.
    pub at_minute: u32,
    /// Extra attempts after a failure (0 to 5).
    pub retries: u32,
    pub retry_delay_secs: u64,
}

impl Default for Plan {
    fn default() -> Self {
        Self { frequency: Schedule::Daily, at_minute: 3 * 60, retries: 2, retry_delay_secs: 300 }
    }
}

impl Plan {
    pub fn clamped(mut self) -> Self {
        self.at_minute = self.at_minute.min(1439);
        self.retries = self.retries.min(5);
        self.retry_delay_secs = self.retry_delay_secs.clamp(1, 3600);
        self
    }

    /// Is a scheduled run due at `now` (Unix seconds)? `last` is the start of the last *scheduled* run. A missed slot
    /// (the PC was off) is run as soon as possible, once.
    pub fn is_due(&self, last: Option<u64>, now: u64) -> bool {
        const DAY: u64 = 86_400;
        let slot = match self.frequency {
            Schedule::Manual => return false,
            Schedule::Hourly => {
                return match last {
                    None => true,
                    Some(l) => now >= l + 3600,
                }
            }
            Schedule::Daily => {
                let today = now / DAY * DAY + u64::from(self.at_minute) * 60;
                if now >= today {
                    today
                } else {
                    today - DAY
                }
            }
            Schedule::Weekly => {
                // Monday at the time (1970-01-01 was a Thursday)
                let days = now / DAY;
                let back = (days + 3) % 7;
                let monday = (days - back) * DAY + u64::from(self.at_minute) * 60;
                if now >= monday {
                    monday
                } else {
                    monday - 7 * DAY
                }
            }
        };
        match last {
            None => true,
            Some(l) => l < slot,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Trigger {
    Scheduled,
    Manual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunStatus {
    /// New data was loaded (and published where that applies).
    Refreshed,
    /// The sources gave the same data as before; nothing was published.
    Unchanged,
    Failed,
    /// Another run of the same job was going; this one did not start.
    Skipped,
}

/// One attempt of one job.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub runs_on: RunsOn,
    pub trigger: Trigger,
    /// 1 for the first attempt, 2 for the first retry, ...
    pub attempt: u32,
    pub started_at: u64,
    pub finished_at: u64,
    pub status: RunStatus,
    pub message: String,
    /// The version that was published, when one was.
    #[serde(default)]
    pub version: Option<u64>,
}

/// What a job reports when it worked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobResult {
    pub changed: bool,
    pub message: String,
    pub version: Option<u64>,
}

const KEEP: usize = 200;
/// A run that has been going for longer than this is taken to be dead (the process was killed): its lock is ignored.
pub const STALE_AFTER_SECS: u64 = 3 * 3600;

/// The history and the lock of one job, in a folder of its own.
pub struct JobStore {
    dir: PathBuf,
}

/// Held while a job runs; releases the lock when dropped.
pub struct Lock {
    path: PathBuf,
}

impl Drop for Lock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

impl JobStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }
    fn history_path(&self) -> PathBuf {
        self.dir.join("history.jsonl")
    }
    fn lock_path(&self) -> PathBuf {
        self.dir.join("running.lock")
    }

    /// Takes the job's lock, or None when another run holds it. A lock older than [`STALE_AFTER_SECS`] is dead and is
    /// taken over.
    pub fn try_lock(&self, now: u64) -> Option<Lock> {
        let _ = fs::create_dir_all(&self.dir);
        let path = self.lock_path();
        for _ in 0..2 {
            match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut f) => {
                    let _ = write!(f, "{now}");
                    return Some(Lock { path });
                }
                Err(_) => {
                    let started: u64 = fs::read_to_string(&path).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0);
                    if now.saturating_sub(started) > STALE_AFTER_SECS {
                        let _ = fs::remove_file(&path);
                        continue;
                    }
                    return None;
                }
            }
        }
        None
    }

    /// Is a run going right now?
    pub fn running(&self, now: u64) -> bool {
        match fs::read_to_string(self.lock_path()) {
            Ok(s) => now.saturating_sub(s.trim().parse().unwrap_or(0)) <= STALE_AFTER_SECS,
            Err(_) => false,
        }
    }

    pub fn append(&self, r: &RunRecord) {
        let _ = fs::create_dir_all(&self.dir);
        if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(self.history_path()) {
            let _ = writeln!(f, "{}", serde_json::to_string(r).unwrap_or_default());
        }
        // keep the file short
        if let Ok(text) = fs::read_to_string(self.history_path()) {
            let lines: Vec<&str> = text.lines().collect();
            if lines.len() > KEEP * 2 {
                let _ = fs::write(self.history_path(), lines[lines.len() - KEEP..].join("\n") + "\n");
            }
        }
    }

    /// The most recent attempts, newest first.
    pub fn history(&self, limit: usize) -> Vec<RunRecord> {
        let text = fs::read_to_string(self.history_path()).unwrap_or_default();
        let mut v: Vec<RunRecord> = text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
        v.reverse();
        v.truncate(limit);
        v
    }

    /// Start of the last attempt that was a scheduled one and the first attempt of its run (retries and manual runs do
    /// not count, so a manual run never makes a scheduled one wait and a retry never counts as a new slot).
    pub fn last_scheduled_start(&self) -> Option<u64> {
        self.history(KEEP).into_iter().find(|r| r.trigger == Trigger::Scheduled && r.attempt == 1).map(|r| r.started_at)
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }
}

/// Runs a job under the lock with the plan's retries and writes every attempt to the history. Returns the last record.
/// `now` and `sleep` are passed in so the retry logic is tested without waiting.
pub fn run_job(store: &JobStore, runs_on: RunsOn, trigger: Trigger, plan: &Plan, now: &dyn Fn() -> u64, sleep: &dyn Fn(u64), job: &mut dyn FnMut(u32) -> Result<JobResult, String>) -> RunRecord {
    let plan = plan.clamped();
    let Some(_lock) = store.try_lock(now()) else {
        let t = now();
        let rec = RunRecord { runs_on, trigger, attempt: 1, started_at: t, finished_at: t, status: RunStatus::Skipped, message: "Another refresh of this report is running; this one did not start.".into(), version: None };
        store.append(&rec);
        return rec;
    };
    let attempts = 1 + plan.retries;
    let mut last = None;
    for attempt in 1..=attempts {
        let started = now();
        let outcome = job(attempt);
        let finished = now();
        let rec = match outcome {
            Ok(r) => RunRecord { runs_on, trigger, attempt, started_at: started, finished_at: finished, status: if r.changed { RunStatus::Refreshed } else { RunStatus::Unchanged }, message: r.message, version: r.version },
            Err(m) => RunRecord { runs_on, trigger, attempt, started_at: started, finished_at: finished, status: RunStatus::Failed, message: if attempt < attempts { format!("{m} Trying again in {} s.", plan.retry_delay_secs) } else { m }, version: None },
        };
        store.append(&rec);
        let failed = rec.status == RunStatus::Failed;
        last = Some(rec);
        if !failed {
            break;
        }
        if attempt < attempts {
            sleep(plan.retry_delay_secs);
        }
    }
    last.expect("at least one attempt")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn plan(f: Schedule, at: u32) -> Plan {
        Plan { frequency: f, at_minute: at, retries: 2, retry_delay_secs: 60 }
    }

    const DAY: u64 = 86_400;

    #[test]
    fn daily_runs_once_per_slot_and_catches_up_after_a_missed_one() {
        let p = plan(Schedule::Daily, 3 * 60);
        let d = 20_000 * DAY; // some day, 00:00 UTC
        assert!(p.is_due(None, d + 100), "never ran: due");
        assert!(p.is_due(Some(d + 100), d + 4 * 3600), "a run before today slot does not cover it");
        assert!(!p.is_due(Some(d - DAY + 5 * 3600), d + 3600), "yesterday slot is done, today is not here yet");
        assert!(p.is_due(Some(d - DAY + 3 * 3600), d + 3 * 3600 + 1), "yesterday's run, today's slot reached");
        assert!(!p.is_due(Some(d + 3 * 3600 + 5), d + 20 * 3600), "ran after today's slot");
        // the PC was off for three days: one catch-up run, then quiet
        assert!(p.is_due(Some(d - 3 * DAY + 3 * 3600), d + 10 * 3600));
        assert!(!p.is_due(Some(d + 10 * 3600), d + 11 * 3600));
        assert!(!plan(Schedule::Manual, 0).is_due(None, d));
    }

    #[test]
    fn hourly_and_weekly() {
        let h = plan(Schedule::Hourly, 0);
        assert!(h.is_due(None, 5) && !h.is_due(Some(1000), 1000 + 3599) && h.is_due(Some(1000), 1000 + 3600));
        let w = plan(Schedule::Weekly, 60);
        // 2026-10-19 was a Monday: days since epoch 20745
        let monday = 20_745 * DAY;
        assert_eq!((20_745 + 3) % 7, 0);
        assert!(w.is_due(Some(monday - 7 * DAY + 3600 + 5), monday + 3601), "last week's run, this Monday's slot");
        assert!(!w.is_due(Some(monday + 3700), monday + 3 * DAY), "ran this week");
        assert!(w.is_due(Some(monday - 7 * DAY + 3600 + 5), monday + 2 * DAY), "a week has passed since the previous slot");
    }

    #[test]
    fn a_failing_job_is_retried_and_every_attempt_is_in_the_history() {
        let dir = tempfile::tempdir().unwrap();
        let store = JobStore::new(dir.path());
        let clock = Cell::new(1000u64);
        let slept = Cell::new(0u64);
        let calls = Cell::new(0u32);
        let rec = run_job(&store, RunsOn::Server, Trigger::Scheduled, &plan(Schedule::Daily, 0), &|| clock.get(), &|s| {
            slept.set(slept.get() + s);
            clock.set(clock.get() + s);
        }, &mut |attempt| {
            calls.set(calls.get() + 1);
            if attempt < 3 {
                Err(format!("source unreachable (attempt {attempt})."))
            } else {
                Ok(JobResult { changed: true, message: "3 tables".into(), version: Some(4) })
            }
        });
        assert_eq!((calls.get(), slept.get()), (3, 120));
        assert_eq!((rec.status, rec.attempt, rec.version), (RunStatus::Refreshed, 3, Some(4)));
        let h = store.history(10);
        assert_eq!(h.iter().map(|r| (r.attempt, r.status)).collect::<Vec<_>>(), [(3, RunStatus::Refreshed), (2, RunStatus::Failed), (1, RunStatus::Failed)]);
        assert!(h[2].message.contains("Trying again in 60 s"));
        assert!(h.iter().all(|r| r.runs_on == RunsOn::Server));
        assert_eq!(store.last_scheduled_start(), Some(1000));
        // without retries a failure ends at once and keeps its own message
        let none = Plan { retries: 0, ..plan(Schedule::Daily, 0) };
        let rec = run_job(&store, RunsOn::ThisPc, Trigger::Manual, &none, &|| clock.get(), &|_| panic!("no sleeping without retries"), &mut |_| Err("disk full".into()));
        assert_eq!((rec.status, rec.message.as_str()), (RunStatus::Failed, "disk full"));
    }

    #[test]
    fn a_second_run_of_the_same_job_is_refused_while_one_is_going() {
        let dir = tempfile::tempdir().unwrap();
        let store = JobStore::new(dir.path());
        let first = store.try_lock(1000).expect("free");
        assert!(store.running(1001));
        assert!(store.try_lock(1001).is_none(), "a second lock is refused");
        let rec = run_job(&store, RunsOn::ThisPc, Trigger::Scheduled, &Plan::default(), &|| 1002, &|_| {}, &mut |_| panic!("must not run"));
        assert_eq!(rec.status, RunStatus::Skipped);
        assert!(rec.message.contains("Another refresh"));
        drop(first);
        assert!(!store.running(1003));
        // a lock left behind by a killed process does not block forever
        let dead = store.try_lock(1000).unwrap();
        std::mem::forget(dead);
        assert!(store.try_lock(1000 + STALE_AFTER_SECS + 1).is_some());
    }

    #[test]
    fn the_history_keeps_only_the_recent_runs() {
        let dir = tempfile::tempdir().unwrap();
        let store = JobStore::new(dir.path());
        for i in 0..450u64 {
            store.append(&RunRecord { runs_on: RunsOn::Server, trigger: Trigger::Manual, attempt: 1, started_at: i, finished_at: i, status: RunStatus::Unchanged, message: String::new(), version: None });
        }
        let h = store.history(1000);
        assert!(h.len() <= 400 && h.len() >= 200, "{}", h.len());
        assert_eq!(h[0].started_at, 449);
    }
}
