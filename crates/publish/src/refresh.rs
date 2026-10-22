//! Scheduled refresh for static sites that have a build system (GitHub Actions).
//!
//! BIForge puts three things in the site repository: a workflow, a *refresh bundle* and a `.gitignore`. The bundle is
//! an ordinary BIForge package (signed by the publisher, encrypted for private reports) that holds the pruned
//! project, a small config, and the whole source files the runner can read. A scheduled workflow downloads the
//! BIForge command line (`biforge-cli refresh`), which opens the bundle with the access key, reloads the sources,
//! writes the next version of the published package and commits it. Signing key and access key are repository
//! secrets. Sources the runner cannot reach (a database on a private network, a file on this PC) cannot be
//! refreshed this way; the dialog says so before it is turned on.

use serde::{Deserialize, Serialize};

use crate::manifest::{AccessLevel, IncludedTable};
use crate::package::PackageFile;

pub const WORKFLOW_PATH: &str = ".github/workflows/biforge-refresh.yml";
pub const BUNDLE_FILE: &str = "refresh.bundle";
pub const CONFIG_PATH: &str = "data/refresh.json";
pub const SECRET_SIGNING: &str = "BIFORGE_SIGNING_KEY";
pub const SECRET_ACCESS: &str = "BIFORGE_ACCESS_KEY";
pub const CLI_VARIABLE: &str = "BIFORGE_CLI_URL";
/// Where the workflow looks for the command line unless the repository variable BIFORGE_CLI_URL says otherwise.
pub const DEFAULT_CLI_URL: &str = "https://github.com/moelsaka01/BIForge/releases/latest/download/biforge-cli.exe";

/// How often the workflow runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Schedule {
    Hourly,
    Daily,
    Weekly,
    /// Only when started by hand from GitHub's Actions page or from BIForge.
    Manual,
}

impl Schedule {
    pub fn parse(s: &str) -> Option<Schedule> {
        match s {
            "hourly" => Some(Schedule::Hourly),
            "daily" => Some(Schedule::Daily),
            "weekly" => Some(Schedule::Weekly),
            "manual" => Some(Schedule::Manual),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Schedule::Hourly => "hourly",
            Schedule::Daily => "daily",
            Schedule::Weekly => "weekly",
            Schedule::Manual => "manual",
        }
    }
}

/// One source the runner reloads: the table and the engine's source description with a path inside the bundle.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshSource {
    pub table: String,
    pub spec: serde_json::Value,
    /// The file as it is called on this PC, for the confirmation list.
    pub original: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshConfig {
    pub format_version: u32,
    pub report_name: String,
    pub publisher_name: String,
    pub package_id: String,
    pub access: AccessLevel,
    pub included: Vec<IncludedTable>,
    pub sources: Vec<RefreshSource>,
}

/// Files the bundle carries, ready for [`crate::package::build`].
pub fn bundle_files(config: &RefreshConfig, project: &[PackageFile], sources: &[PackageFile]) -> crate::Result<Vec<PackageFile>> {
    let mut files = vec![PackageFile { path: CONFIG_PATH.into(), bytes: serde_json::to_vec_pretty(config)? }];
    files.extend(project.iter().cloned());
    files.extend(sources.iter().cloned());
    Ok(files)
}

pub fn workflow_yaml(schedule: Schedule) -> String {
    let on = match schedule {
        Schedule::Hourly => "  schedule:\n    - cron: \"17 * * * *\"\n  workflow_dispatch: {}\n",
        Schedule::Daily => "  schedule:\n    - cron: \"17 5 * * *\"\n  workflow_dispatch: {}\n",
        Schedule::Weekly => "  schedule:\n    - cron: \"17 5 * * 1\"\n  workflow_dispatch: {}\n",
        Schedule::Manual => "  workflow_dispatch: {}\n",
    };
    format!(
        "# Written by BIForge. Reloads the report's data and publishes a new version when it changed.\n# Turn it off from BIForge (Publish & Share > Scheduled refresh) or delete this file.\nname: BIForge refresh\non:\n{on}permissions:\n  contents: write\nconcurrency:\n  group: biforge-refresh\n  cancel-in-progress: false\njobs:\n  refresh:\n    runs-on: windows-latest\n    timeout-minutes: 30\n    steps:\n      - uses: actions/checkout@v4\n      - name: Download the BIForge command line\n        shell: pwsh\n        env:\n          CLI_URL: ${{{{ vars.{CLI_VARIABLE} || '{DEFAULT_CLI_URL}' }}}}\n        run: Invoke-WebRequest -Uri $env:CLI_URL -OutFile biforge-cli.exe\n      - name: Refresh\n        shell: pwsh\n        env:\n          {SECRET_SIGNING}: ${{{{ secrets.{SECRET_SIGNING} }}}}\n          {SECRET_ACCESS}: ${{{{ secrets.{SECRET_ACCESS} }}}}\n        run: ./biforge-cli.exe refresh --site .\n      - name: Publish the new version\n        shell: pwsh\n        run: |\n          git config user.name \"BIForge refresh\"\n          git config user.email \"biforge-refresh@users.noreply.github.com\"\n          git add -A\n          if (git status --porcelain) {{\n            git commit -m \"BIForge: scheduled refresh\"\n            git push\n          }} else {{\n            Write-Host \"Nothing changed.\"\n          }}\n"
    )
}

pub const GITIGNORE: &str = "# BIForge refresh: the downloaded command line is never committed\nbiforge-cli.exe\n";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_workflow_has_the_schedule_the_secrets_and_no_literal_secret() {
        let y = workflow_yaml(Schedule::Daily);
        assert!(y.contains("cron: \"17 5 * * *\"") && y.contains("workflow_dispatch"));
        assert!(y.contains("secrets.BIFORGE_SIGNING_KEY") && y.contains("secrets.BIFORGE_ACCESS_KEY"));
        assert!(y.contains("vars.BIFORGE_CLI_URL ||"));
        assert!(y.contains("contents: write"));
        assert!(!y.contains("AGE-SECRET"), "no key material");
        assert!(workflow_yaml(Schedule::Manual).contains("on:\n  workflow_dispatch: {}\npermissions"));
        assert!(!workflow_yaml(Schedule::Manual).contains("cron"));
        assert!(workflow_yaml(Schedule::Weekly).contains("* * 1"));
    }

    #[test]
    fn schedules_parse() {
        assert_eq!(Schedule::parse("daily"), Some(Schedule::Daily));
        assert_eq!(Schedule::parse("hourly"), Some(Schedule::Hourly));
        assert_eq!(Schedule::parse("yearly"), None);
        assert_eq!(Schedule::Weekly.as_str(), "weekly");
    }
}
