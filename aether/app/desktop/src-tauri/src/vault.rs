use anyhow::Result;
use keyring::Entry;

const SERVICE_NAME: &str = "app.aethermesh.desktop";

/// Persist a secret in the OS keychain (Credential Manager / Keychain / libsecret).
pub fn save_secret(key: &str, value: &str) -> Result<()> {
    let entry = Entry::new(SERVICE_NAME, key)?;
    entry.set_password(value)?;
    Ok(())
}

/// Retrieve a secret from the OS keychain.
/// Returns `Ok(None)` when no credential is found.
pub fn load_secret(key: &str) -> Result<Option<String>> {
    let entry = Entry::new(SERVICE_NAME, key)?;
    match entry.get_password() {
        Ok(pw) => Ok(Some(pw)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Remove a secret from the OS keychain.
pub fn delete_secret(key: &str) -> Result<()> {
    let entry = Entry::new(SERVICE_NAME, key)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}
