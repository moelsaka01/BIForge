//! Orchestration: the one place that turns "publish this report to that target" into a package, an adapter call,
//! a stored target state and an audit entry. Adapters never see keys; the UI and this module both refuse actions
//! the adapter's capabilities do not declare.

use std::collections::{BTreeMap, BTreeSet};

use crate::adapter::*;
use crate::audit::{self, AuditEvent};
use crate::keys::{new_package_id, sha256_hex, AccessKey, Identity, KeyStore};
use crate::manifest::*;
use crate::package::{self, PackageFile};
use crate::refresh::{self, RefreshConfig, Schedule};
use crate::targets::{Target, TargetStatus, TargetStore};
use crate::time::now_rfc3339;
use crate::{Error, Result};

pub const SIGNING_KEY_NAME: &str = "biforge.publisher.signing";

pub fn access_key_name(target_id: &str) -> String {
    format!("biforge.publisher.access.{target_id}")
}

pub struct PublishRequest {
    pub target_id: String,
    pub report_name: String,
    pub publisher_name: String,
    /// The tables and columns whose data is in `files`.
    pub included: Vec<IncludedTable>,
    /// What the user confirmed on the screen that listed the tables and columns. Must equal `included`.
    pub confirmed: Vec<IncludedTable>,
    pub permissions: Vec<Permission>,
    pub files: Vec<PackageFile>,
}

#[derive(Debug)]
pub struct RefreshRequest {
    pub target_id: String,
    pub report_name: String,
    pub publisher_name: String,
    pub included: Vec<IncludedTable>,
    pub schedule: Schedule,
    /// What the runner reloads: the table, the engine's source description (paths inside the bundle) and the file's
    /// name on this PC.
    pub sources: Vec<refresh::RefreshSource>,
    /// The file names the user confirmed on screen; must equal the names in `sources`.
    pub confirmed_sources: Vec<String>,
    /// The pruned project exactly as published (paths start with project/).
    pub project_files: Vec<PackageFile>,
    /// The whole source files (paths start with data/src/).
    pub source_files: Vec<PackageFile>,
}

#[derive(Debug)]
pub struct PublishOutcome {
    pub state: RemoteState,
    /// Set when a new access key was created (first private publish, or key rotation). Shown once; the owner can
    /// read it again from the credential store through [`Publisher::access_key`].
    pub new_access_key: Option<String>,
}

pub struct Publisher<'a> {
    pub registry: &'a Registry,
    pub keys: &'a dyn KeyStore,
    pub store: &'a TargetStore,
}

fn normalized(t: &[IncludedTable]) -> BTreeMap<String, BTreeSet<String>> {
    t.iter().map(|x| (x.table.clone(), x.columns.iter().cloned().collect())).collect()
}

impl<'a> Publisher<'a> {
    fn event(&self, t: &Target, event: &str, detail: String) {
        // an audit failure must not hide the result of the action itself, but it is never silent: it is returned
        // by `audit_log` readers as a missing entry, and the error text goes to the target's lastError.
        let _ = audit::append(self.store, &AuditEvent { time: now_rfc3339(), event: event.into(), target_id: t.id.clone(), adapter_id: t.adapter_id.clone(), detail });
    }

    fn caps(&self, t: &Target) -> Result<(&'a dyn Adapter, Capabilities)> {
        let a = self.registry.get(&t.adapter_id)?;
        let c = a.info().capabilities;
        if !c.implemented {
            return Err(Error::Unsupported { adapter: a.info().name, operation: "anything yet (not implemented)".into() });
        }
        Ok((a, c))
    }

    pub fn access_key(&self, target_id: &str) -> Result<Option<String>> {
        self.keys.get(&access_key_name(target_id))
    }

    pub fn publish(&self, req: &PublishRequest) -> Result<PublishOutcome> {
        self.run_publish(req, false)
    }

    /// Revokes access by key rotation: a new access key is made and the next version is encrypted for it only.
    /// Viewers holding the old key cannot open the new version. Copies they already have stay readable.
    pub fn rotate_key(&self, req: &PublishRequest) -> Result<PublishOutcome> {
        self.run_publish(req, true)
    }

    fn run_publish(&self, req: &PublishRequest, rotate: bool) -> Result<PublishOutcome> {
        let mut target = self.store.get(&req.target_id)?;
        let (adapter, caps) = self.caps(&target)?;
        let mut have_version = target.last_version.filter(|_| target.status != TargetStatus::Unpublished);
        if target.settings.contains_key("refresh") {
            if rotate {
                return Err(Error::Adapter("Turn off scheduled refresh before revoking access (it holds the old key), then turn it on again afterwards.".into()));
            }
            // the runner may have published newer versions since this PC last did
            if let Ok(Some(remote)) = adapter.status(&target) {
                have_version = have_version.map(|v| v.max(remote.version));
            }
        }
        match target.access {
            AccessLevel::Public if !caps.public_access => return Err(Error::Unsupported { adapter: adapter.info().name, operation: "public packages".into() }),
            AccessLevel::Private if !caps.private_access => return Err(Error::Unsupported { adapter: adapter.info().name, operation: "private (encrypted) packages".into() }),
            _ => {}
        }
        if have_version.is_some() && !caps.update {
            return Err(Error::Unsupported { adapter: adapter.info().name, operation: "updates".into() });
        }
        if rotate && !(caps.key_rotation && target.access == AccessLevel::Private) {
            return Err(Error::Unsupported { adapter: adapter.info().name, operation: "revoking access by key rotation".into() });
        }
        if normalized(&req.included) != normalized(&req.confirmed) {
            return Err(Error::NotConfirmed);
        }
        let issues = adapter.validate(&target);
        if let Some(i) = issues.iter().find(|i| i.severity == Severity::Error) {
            return Err(Error::Adapter(i.message.clone()));
        }

        let signer = Identity::load_or_create(self.keys, SIGNING_KEY_NAME)?;
        let key_name = access_key_name(&target.id);
        let mut new_access_key = None;
        let mut recipients = Vec::new();
        if target.access == AccessLevel::Private {
            let existing = self.keys.get(&key_name)?;
            let secret = match (existing, rotate) {
                (Some(s), false) => s,
                _ => {
                    let k = AccessKey::generate();
                    self.keys.set(&key_name, &k.secret)?;
                    new_access_key = Some(k.secret.clone());
                    k.secret
                }
            };
            recipients.push(AccessKey::public_of(&secret)?);
        }

        let package_id = target.package_id.clone().unwrap_or_else(new_package_id);
        let version = have_version.map(|v| v + 1).unwrap_or(target.last_version.map(|v| v + 1).unwrap_or(1));
        let now = now_rfc3339();
        let bytes = package::build(
            package::BuildInput {
                package_id: package_id.clone(),
                version,
                report_name: req.report_name.clone(),
                publisher_name: req.publisher_name.clone(),
                access: target.access,
                included: req.included.clone(),
                permissions: req.permissions.clone(),
                created_at: now.clone(),
                files: req.files.clone(),
                recipients,
            },
            &signer,
        )?;
        let meta = PackageMeta { package_id: package_id.clone(), report_name: req.report_name.clone(), version, access: target.access, sha256: sha256_hex(&bytes), time: now.clone() };
        let result = if have_version.is_some() { adapter.update(&target, &bytes, &meta) } else { adapter.publish(&target, &bytes, &meta) };
        match result {
            Ok(state) => {
                target.package_id = Some(package_id);
                target.last_version = Some(version);
                target.last_sync = Some(now.clone());
                target.history.push((version, now));
                target.status = TargetStatus::Published;
                target.last_error = None;
                self.store.put(target.clone())?;
                let kind = if rotate { "rotate-key" } else if have_version.is_some() { "update" } else { "publish" };
                let tables: Vec<String> = req.included.iter().map(|t| format!("{}({})", t.table, t.columns.len())).collect();
                self.event(&target, kind, format!("version {version}, access {:?}, tables: {}", target.access, tables.join(", ")));
                Ok(PublishOutcome { state, new_access_key })
            }
            Err(e) => {
                if new_access_key.is_some() && !rotate {
                    // nothing was published with the new key; keep the store tidy
                    let _ = self.keys.delete(&key_name);
                }
                target.status = TargetStatus::Error;
                target.last_error = Some(e.to_string());
                let _ = self.store.put(target);
                Err(e)
            }
        }
    }

    /// Turns on scheduled refresh: the bundle (a signed, for private reports encrypted package with the project and
    /// the whole source files) and the workflow go to the site, the signing and access keys become the runner's
    /// secrets. `confirmed_sources` must equal the files the bundle will carry: whole source files leave this
    /// computer, including columns that are not published.
    pub fn enable_refresh(&self, req: &RefreshRequest) -> Result<()> {
        let mut target = self.store.get(&req.target_id)?;
        let (adapter, caps) = self.caps(&target)?;
        if !caps.scheduled_refresh {
            return Err(Error::Unsupported { adapter: adapter.info().name, operation: "scheduled refresh".into() });
        }
        let Some(package_id) = target.package_id.clone().filter(|_| target.status == TargetStatus::Published) else {
            return Err(Error::Adapter("Publish the report first, then turn on scheduled refresh.".into()));
        };
        let mut shown: Vec<&String> = req.sources.iter().map(|s| &s.original).collect();
        let mut confirmed: Vec<&String> = req.confirmed_sources.iter().collect();
        shown.sort();
        confirmed.sort();
        if shown != confirmed {
            return Err(Error::NotConfirmed);
        }
        if req.sources.is_empty() {
            return Err(Error::Adapter("Choose at least one source file the runner can reload.".into()));
        }
        let signer = Identity::load_or_create(self.keys, SIGNING_KEY_NAME)?;
        let key_name = access_key_name(&target.id);
        let access_secret = if target.access == AccessLevel::Private {
            Some(self.keys.get(&key_name)?.ok_or_else(|| Error::Adapter("The access key of this report is missing from the credential store.".into()))?)
        } else {
            None
        };
        let recipients = match &access_secret {
            Some(s) => vec![AccessKey::public_of(s)?],
            None => vec![],
        };
        let config = RefreshConfig {
            format_version: 1,
            report_name: req.report_name.clone(),
            publisher_name: req.publisher_name.clone(),
            package_id,
            access: target.access,
            included: req.included.clone(),
            sources: req.sources.clone(),
        };
        let files: Vec<PackageFile> = refresh::bundle_files(&config, &req.project_files, &req.source_files)?;
        let bundle = package::build(
            package::BuildInput {
                package_id: new_package_id(),
                version: 1,
                report_name: format!("{} (refresh bundle)", req.report_name),
                publisher_name: req.publisher_name.clone(),
                access: target.access,
                included: vec![],
                permissions: vec![],
                created_at: now_rfc3339(),
                files,
                recipients,
            },
            &signer,
        )?;
        let site_files = vec![
            (refresh::WORKFLOW_PATH.to_string(), refresh::workflow_yaml(req.schedule).into_bytes()),
            (refresh::BUNDLE_FILE.to_string(), bundle),
            (".gitignore".to_string(), refresh::GITIGNORE.as_bytes().to_vec()),
        ];
        let mut secrets = vec![(refresh::SECRET_SIGNING.to_string(), signer.secret())];
        if let Some(s) = access_secret {
            secrets.push((refresh::SECRET_ACCESS.to_string(), s));
        }
        adapter.configure_refresh(&target, &site_files, &secrets)?;
        target.settings.insert("refresh".into(), req.schedule.as_str().into());
        self.store.put(target.clone())?;
        self.event(&target, "enable-refresh", format!("{}, sources: {}", req.schedule.as_str(), req.sources.iter().map(|s| s.original.clone()).collect::<Vec<_>>().join(", ")));
        Ok(())
    }

    pub fn disable_refresh(&self, target_id: &str) -> Result<()> {
        let mut target = self.store.get(target_id)?;
        let (adapter, caps) = self.caps(&target)?;
        if !caps.scheduled_refresh {
            return Err(Error::Unsupported { adapter: adapter.info().name, operation: "scheduled refresh".into() });
        }
        adapter.disable_refresh(&target)?;
        target.settings.remove("refresh");
        self.store.put(target.clone())?;
        self.event(&target, "disable-refresh", "workflow, bundle and secrets removed from the site".into());
        Ok(())
    }

    /// Starts one refresh on the runner now; returns the address where it can be watched.
    pub fn refresh_now(&self, target_id: &str) -> Result<String> {
        let target = self.store.get(target_id)?;
        let (adapter, caps) = self.caps(&target)?;
        if !caps.scheduled_refresh || !target.settings.contains_key("refresh") {
            return Err(Error::Adapter("Scheduled refresh is not turned on for this destination.".into()));
        }
        let url = adapter.trigger_refresh(&target)?;
        self.event(&target, "refresh-now", format!("started: {url}"));
        Ok(url)
    }

    pub fn status(&self, target_id: &str) -> Result<Option<RemoteState>> {
        let t = self.store.get(target_id)?;
        let (a, _) = self.caps(&t)?;
        a.status(&t)
    }

    pub fn share_link(&self, target_id: &str) -> Result<String> {
        let t = self.store.get(target_id)?;
        let (a, c) = self.caps(&t)?;
        if !c.share_link {
            return Err(Error::Unsupported { adapter: a.info().name, operation: "share links".into() });
        }
        let link = a.share_link(&t)?;
        self.event(&t, "share-link", "link created (it contains no access key)".into());
        Ok(link)
    }

    /// Removes the package from the destination. The target stays so it can be published again.
    pub fn unpublish(&self, target_id: &str) -> Result<()> {
        let mut t = self.store.get(target_id)?;
        let (a, c) = self.caps(&t)?;
        if !c.unpublish {
            return Err(Error::Unsupported { adapter: a.info().name, operation: "unpublishing".into() });
        }
        a.unpublish(&t)?;
        t.status = TargetStatus::Unpublished;
        self.store.put(t.clone())?;
        self.event(&t, "unpublish", "package removed from the destination".into());
        Ok(())
    }

    pub fn disconnect(&self, target_id: &str) -> Result<()> {
        let mut t = self.store.get(target_id)?;
        let (a, _) = self.caps(&t)?;
        a.disconnect(&mut t)?;
        t.account = None;
        self.store.put(t.clone())?;
        self.event(&t, "disconnect", "account connection removed (published data is untouched)".into());
        Ok(())
    }

    /// Removes the target and, with it, the stored access key.
    pub fn delete_target(&self, target_id: &str) -> Result<()> {
        let t = self.store.get(target_id)?;
        self.store.remove(target_id)?;
        self.keys.delete(&access_key_name(target_id))?;
        self.event(&t, "delete-target", "target removed from this report".into());
        Ok(())
    }
}
