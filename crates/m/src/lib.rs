//! m crate. Not implemented yet.

/// Returns the crate name; placeholder so the workspace builds and tests run.
pub fn crate_name() -> &'static str {
    "biforge-m"
}

#[cfg(test)]
mod tests {
    #[test]
    fn crate_name_is_stable() {
        assert_eq!(super::crate_name(), "biforge-m");
    }
}
