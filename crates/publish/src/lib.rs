//! BIForge publishing engine: one package format, one adapter interface, a target store per report.
//!
//! * [`package`]: build / read a signed (ed25519), optionally encrypted (age) package of a project plus its data.
//! * [`adapter`]: the adapter trait, its declared [`adapter::Capabilities`] and the list of known adapters.
//! * [`local`]: the file/folder adapter (the first real adapter).
//! * [`targets`]: publication targets stored per report, and the audit log.
//! * [`publisher`]: orchestration (confirmation, capability gating, versions, key rotation, audit).
//!
//! No network code lives here; provider adapters arrive in later phases (docs/ONLINE_PLAN.md).
pub mod adapter;
pub mod audit;
pub mod cloudflare;
pub mod deeplink;
pub mod error;
pub mod feed;
pub mod http;
pub mod keys;
pub mod github;
pub mod local;
pub mod manifest;
pub mod package;
pub mod publisher;
pub mod subscribe;
pub mod targets;
pub mod time;

pub use error::{Error, Result};
