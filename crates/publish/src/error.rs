use thiserror::Error;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Error)]
pub enum Error {
    #[error("not a BIForge package: {0}")]
    BadFormat(String),
    #[error("the package signature is not valid: the package was changed or was not signed by the publisher it names")]
    SignatureInvalid,
    #[error("the package contents do not match the signed description: {0}")]
    Tampered(String),
    #[error("this package is encrypted: an access key is needed")]
    KeyRequired,
    #[error("the access key does not open this package (it may have been revoked)")]
    WrongKey,
    #[error("the package is signed by a different publisher than the one you subscribed to")]
    UntrustedPublisher,
    #[error("unsafe file path in package: {0}")]
    UnsafePath(String),
    #[error("{0} looks like it contains a secret ({1}); packages never contain secrets")]
    SecretFound(String, String),
    #[error("{0}")]
    Invalid(String),
    #[error("the package is larger than the allowed size")]
    TooLarge,
    #[error("the confirmation does not match what would be published; review the list of tables and columns again")]
    NotConfirmed,
    #[error("{adapter} does not support {operation}")]
    Unsupported { adapter: String, operation: String },
    #[error("unknown destination type \"{0}\"")]
    UnknownAdapter(String),
    #[error("no publication target \"{0}\"")]
    UnknownTarget(String),
    #[error("{0}")]
    Adapter(String),
    /// The file at the destination was changed by someone else since this PC last wrote it.
    #[error("{0}")]
    Conflict(String),
    #[error("credential store: {0}")]
    KeyStore(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
}
