//! Small secrets kept for the person on this computer: the sign-in. On
//! Windows they live in the app's own folder, never the notes folder (which
//! may be synced), one file each, encrypted with DPAPI, tied to this Windows
//! account: a copy taken to another computer or account is useless. macOS
//! keeps them in the Keychain, and Linux in the Secret Service (GNOME
//! Keyring, KWallet); where Linux has none running, they go in a file only
//! this user can read. The WebView's storage never holds the sign-in.

use crate::db::{Error, Result};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use zeroize::Zeroize;

/// Mixed into the encryption, so the file can't be decrypted without it.
#[cfg(windows)]
const ENTROPY: &[u8] = b"thoughtdesk.secrets.v1";

/// Names are file names: letters, digits, '.', '_' and '-', not starting with a dot.
fn valid(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('.')
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

pub struct Secrets {
    dir: PathBuf,
    /// Whether the system's keystore is tried first (macOS, Linux). A test
    /// that stands for two computers turns it off: one machine has one
    /// keystore, whatever folder each `Secrets` is given.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    keystore: bool,
}

impl Secrets {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            keystore: true,
        }
    }

    /// Kept in files in `dir` alone, never in the system's keystore.
    #[cfg(test)]
    pub fn files_only(dir: PathBuf) -> Self {
        Self {
            dir,
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            keystore: false,
        }
    }

    fn path(&self, name: &str) -> Result<PathBuf> {
        if !valid(name) {
            return Err(Error(format!("Not a secret's name: {name}")));
        }
        Ok(self.dir.join(format!("{name}.bin")))
    }

    pub fn get(&self, name: &str) -> Result<Option<String>> {
        let path = self.path(name)?;
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        if let Some(value) = self.keystore.then(|| keystore::get(name)).flatten() {
            return Ok(Some(value));
        }
        let sealed = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(Error(e.to_string())),
        };
        match unseal(&sealed).and_then(|plain| String::from_utf8(plain).ok()) {
            Some(value) => Ok(Some(value)),
            // Damaged, or another Windows account's: set it aside (signing in again
            // makes a new one) rather than delete what may be someone's only copy.
            None => {
                let _ = fs::rename(&path, path.with_extension("bad"));
                Ok(None)
            }
        }
    }

    pub fn set(&self, name: &str, value: &str) -> Result<()> {
        let path = self.path(name)?;
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        if self.keystore && keystore::set(name, value) {
            // A copy left from a time without a keystore goes.
            let _ = fs::remove_file(&path);
            return Ok(());
        }
        make_private_dir(&self.dir).map_err(|e| Error(e.to_string()))?;
        let sealed = seal(value.as_bytes()).ok_or_else(|| Error("Windows couldn't encrypt the sign-in".into()))?;
        // Written whole, then moved into place, so a crash never leaves half a file.
        let tmp = path.with_extension("tmp");
        write_private(&tmp, &sealed).map_err(|e| Error(e.to_string()))?;
        fs::rename(&tmp, &path).map_err(|e| Error(e.to_string()))
    }

    pub fn remove(&self, name: &str) -> Result<()> {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        if self.keystore {
            keystore::remove(name);
        }
        match fs::remove_file(self.path(name)?) {
            Err(e) if e.kind() != ErrorKind::NotFound => Err(Error(e.to_string())),
            _ => Ok(()),
        }
    }

    /// The sync vault key, kept per account so two accounts on one computer
    /// don't share one. Stored as hex like any other secret.
    pub fn store_vault_key(&self, account: &str, key: &[u8; 32]) -> Result<()> {
        let mut hex: String = key.iter().map(|b| format!("{b:02x}")).collect();
        let stored = self.set(&vault_key_name(account), &hex);
        hex.zeroize();
        stored
    }

    /// `None` when there is none, or it can't be read.
    pub fn load_vault_key(&self, account: &str) -> Option<[u8; 32]> {
        let mut hex = self.get(&vault_key_name(account)).ok()??;
        let key = parse_key(&hex);
        hex.zeroize();
        key
    }

    pub fn delete_vault_key(&self, account: &str) {
        let _ = self.remove(&vault_key_name(account));
    }
}

fn parse_key(hex: &str) -> Option<[u8; 32]> {
    if hex.len() != 64 || !hex.is_ascii() {
        return None;
    }
    let mut key = [0u8; 32];
    for (i, byte) in key.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(key)
}

/// The account id is hashed so the name is always a safe file name of fixed length.
fn vault_key_name(account: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(account.as_bytes());
    let id: String = digest[..16].iter().map(|b| format!("{b:02x}")).collect();
    format!("thoughtdesk.sync-key-{id}")
}

/// The secrets folder, readable by this user only (macOS and Linux; on
/// Windows the encryption does that).
fn make_private_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
        // One made by an older version may be open to others.
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
    }
    #[cfg(not(unix))]
    fs::create_dir_all(dir)
}

/// Writes a file that is private from the moment it exists (mode 0600), not
/// readable by others in between creating and restricting it.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        // A leftover from a crash may have wider rights, which `mode` doesn't change.
        let _ = fs::remove_file(path);
        fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path)?.write_all(bytes)
    }
    #[cfg(not(unix))]
    fs::write(path, bytes)
}

#[cfg(windows)]
fn seal(plain: &[u8]) -> Option<Vec<u8>> {
    dpapi(plain, true)
}

#[cfg(windows)]
fn unseal(sealed: &[u8]) -> Option<Vec<u8>> {
    dpapi(sealed, false)
}

/// Encrypts (or decrypts) for the current Windows account, never asking anything on screen.
#[cfg(windows)]
fn dpapi(input: &[u8], protect: bool) -> Option<Vec<u8>> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};

    let data = CRYPT_INTEGER_BLOB { cbData: u32::try_from(input.len()).ok()?, pbData: input.as_ptr() as *mut u8 };
    let entropy = CRYPT_INTEGER_BLOB { cbData: ENTROPY.len() as u32, pbData: ENTROPY.as_ptr() as *mut u8 };
    let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: null_mut() };
    // SAFETY: the blobs point at live slices, and DPAPI only reads them; it
    // allocates `out`, which is copied and then freed with LocalFree.
    let ok = unsafe {
        if protect {
            CryptProtectData(&data, null(), &entropy, null(), null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        } else {
            CryptUnprotectData(&data, null_mut(), &entropy, null(), null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        }
    };
    if ok == 0 || out.pbData.is_null() {
        return None;
    }
    let bytes = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize) }.to_vec();
    unsafe { LocalFree(out.pbData as _) };
    Some(bytes)
}

/// The system's own keystore: the Keychain on macOS, the Secret Service on
/// Linux. When it has nothing, or there's no keystore to use, the file is
/// looked at instead.
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod keystore {
    use keyring::Entry;

    /// Who the entries belong to in the keystore, as the app's identifier.
    const SERVICE: &str = "app.thoughtdesk.desktop";

    pub fn get(name: &str) -> Option<String> {
        Entry::new(SERVICE, name).and_then(|e| e.get_password()).ok()
    }

    pub fn set(name: &str, value: &str) -> bool {
        Entry::new(SERVICE, name).and_then(|e| e.set_password(value)).is_ok()
    }

    pub fn remove(name: &str) {
        let _ = Entry::new(SERVICE, name).and_then(|e| e.delete_credential());
    }
}

/// Outside Windows the file is the fallback, kept as it is: it's readable by
/// this user only.
#[cfg(not(windows))]
fn seal(plain: &[u8]) -> Option<Vec<u8>> {
    Some(plain.to_vec())
}

#[cfg(not(windows))]
fn unseal(sealed: &[u8]) -> Option<Vec<u8>> {
    Some(sealed.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> (Secrets, PathBuf) {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("td-secrets-{}-{nanos}", std::process::id()));
        (Secrets::new(dir.clone()), dir)
    }

    #[test]
    fn keeps_replaces_and_forgets_a_secret() {
        let (secrets, dir) = fresh();
        assert_eq!(secrets.get("td-test.auth").unwrap(), None);
        secrets.set("td-test.auth", r#"{"refresh_token":"r1"}"#).unwrap();
        assert_eq!(secrets.get("td-test.auth").unwrap().as_deref(), Some(r#"{"refresh_token":"r1"}"#));
        secrets.set("td-test.auth", "second").unwrap();
        assert_eq!(secrets.get("td-test.auth").unwrap().as_deref(), Some("second"));
        secrets.remove("td-test.auth").unwrap();
        assert_eq!(secrets.get("td-test.auth").unwrap(), None);
        secrets.remove("td-test.auth").unwrap();
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(windows)]
    #[test]
    fn the_file_is_encrypted_and_a_damaged_one_is_forgotten() {
        let (secrets, dir) = fresh();
        secrets.set("td-test.auth", "refresh-token-in-plain-sight").unwrap();
        let file = dir.join("td-test.auth.bin");
        let raw = fs::read(&file).unwrap();
        assert!(!raw.windows(13).any(|w| w == b"refresh-token"), "not stored in plain text");
        fs::write(&file, b"not something DPAPI made").unwrap();
        assert_eq!(secrets.get("td-test.auth").unwrap(), None);
        assert!(!file.exists(), "a file that can't be read is moved out of the way");
        assert_eq!(fs::read(dir.join("td-test.auth.bad")).unwrap(), b"not something DPAPI made", "and kept");
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn the_fallback_file_is_private() {
        use std::os::unix::fs::PermissionsExt;
        // The pieces `set` uses (a keyring, where there is one, may take the secret instead).
        let (_, dir) = fresh();
        make_private_dir(&dir).unwrap();
        write_private(&dir.join("s.bin"), b"v").unwrap();
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&dir.join("s.bin")), 0o600);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn vault_keys_are_kept_per_account() {
        let (secrets, dir) = fresh();
        assert_eq!(secrets.load_vault_key("user_a"), None);
        secrets.store_vault_key("user_a", &[1u8; 32]).unwrap();
        secrets.store_vault_key("user_b", &[2u8; 32]).unwrap();
        assert_eq!(secrets.load_vault_key("user_a"), Some([1u8; 32]));
        assert_eq!(secrets.load_vault_key("user_b"), Some([2u8; 32]));
        secrets.delete_vault_key("user_a");
        assert_eq!(secrets.load_vault_key("user_a"), None);
        assert_eq!(secrets.load_vault_key("user_b"), Some([2u8; 32]));
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn the_file_and_its_folder_are_private_from_the_start() {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &std::path::Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        // The folder is tightened even when it already exists with the defaults.
        let (_, dir) = fresh();
        fs::create_dir_all(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        make_private_dir(&dir).unwrap();
        assert_eq!(mode(&dir), 0o700);
        let nested = dir.join("a").join("b");
        make_private_dir(&nested).unwrap();
        assert_eq!(mode(&nested), 0o700);
        // The file never exists with wider permissions, and a stale one is replaced.
        let file = dir.join("one.bin");
        fs::write(&file, b"old").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        write_private(&file, b"secret").unwrap();
        assert_eq!(mode(&file), 0o600);
        assert_eq!(fs::read(&file).unwrap(), b"secret");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn names_stay_inside_the_folder() {
        let (secrets, _) = fresh();
        for name in ["", "../x", "a/b", "a\\b", ".hidden", "a b", &"x".repeat(65)] {
            assert!(secrets.set(name, "v").is_err(), "{name:?}");
            assert!(secrets.get(name).is_err(), "{name:?}");
        }
        assert!(valid("thoughtdesk.auth-code-verifier"));
    }
}
