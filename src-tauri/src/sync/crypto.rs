//! The encryption for syncing, as pure functions: no files, no database, no
//! network. Everything that comes from the server is hostile, so opening
//! never panics and never trusts a length.
//!
//! One random vault key per account makes three working keys (records and
//! text, names, file bytes). Sealed items are
//! `version | flags | nonce (24) | ciphertext + tag` (XChaCha20-Poly1305), with
//! the kind and key of the item as associated data so the server can't swap
//! one item for another. See "Encryption" in docs/sync.md.

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use flate2::read::DeflateDecoder;
use flate2::write::DeflateEncoder;
use flate2::Compression;
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use std::fmt;
use std::io::{Read, Write};
use zeroize::Zeroize;

const VERSION: u8 = 1;
const FLAG_DEFLATED: u8 = 1;
const NONCE_LEN: usize = 24;
const TAG_LEN: usize = 16;
const HEADER_LEN: usize = 2 + NONCE_LEN;
/// The most a sealed item may inflate to, so a small hostile blob can't exhaust memory.
const MAX_INFLATED: u64 = 64 * 1024 * 1024;
const WRAP_AAD: &[u8] = b"td-sync-wrap-v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CryptoError {
    /// Sealed by a newer version of the app.
    NewerFormat,
    /// Damaged, changed, or not made with this key.
    Tampered,
    /// The recovery key doesn't match what was typed or stored.
    BadRecoveryKey,
}

impl fmt::Display for CryptoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            CryptoError::NewerFormat => "Update Thought Desk to keep syncing",
            CryptoError::Tampered => "Synced data was damaged or changed, so it was ignored",
            CryptoError::BadRecoveryKey => "That recovery key isn't right. Check it and try again",
        })
    }
}

impl std::error::Error for CryptoError {}

/// The working keys, made from the vault key. No `Debug`, so they can't be logged,
/// and they're wiped from memory when dropped.
pub struct VaultKeys {
    records: [u8; 32],
    names: [u8; 32],
    files: [u8; 32],
    proof: [u8; 32],
}

impl Drop for VaultKeys {
    fn drop(&mut self) {
        self.records.zeroize();
        self.names.zeroize();
        self.files.zeroize();
        self.proof.zeroize();
    }
}

impl VaultKeys {
    pub fn from_vault_key(vault_key: &[u8; 32]) -> Self {
        Self {
            records: derive(vault_key, b"td sync records v1"),
            names: derive(vault_key, b"td sync names v1"),
            files: derive(vault_key, b"td sync files v1"),
            proof: derive(vault_key, b"td sync proof v1"),
        }
    }
}

/// What the mailbox is shown to prove this computer holds the vault key (the
/// `X-Vault-Proof` header). It says nothing of the key itself.
pub fn vault_proof(keys: &VaultKeys) -> [u8; 32] {
    keys.proof
}

/// HKDF-SHA256 with no salt.
fn derive(secret: &[u8], info: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    // 32 bytes is far below HKDF's limit, so this can't fail.
    Hkdf::<Sha256>::new(None, secret).expand(info, &mut out).expect("32 bytes is a valid HKDF length");
    out
}

fn random<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    // Without the system's randomness nothing can be sealed safely.
    getrandom::getrandom(&mut out).expect("the system has no random numbers");
    out
}

pub fn new_vault_key() -> [u8; 32] {
    random()
}

// ---- Sealing and opening ----

fn aad(kind: &str, key: &str) -> Vec<u8> {
    format!("td-sync-v1|{kind}|{key}").into_bytes()
}

fn encrypt(key: &[u8; 32], aad: &[u8], flags: u8, plain: &[u8]) -> Vec<u8> {
    let nonce = random::<NONCE_LEN>();
    let cipher = XChaCha20Poly1305::new(key.into());
    let sealed = cipher
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: plain, aad })
        .expect("sealing in memory can't fail");
    let mut out = Vec::with_capacity(HEADER_LEN + sealed.len());
    out.extend_from_slice(&[VERSION, flags]);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&sealed);
    out
}

/// Returns the plain bytes and whether they were deflated.
fn decrypt(key: &[u8; 32], aad: &[u8], sealed: &[u8]) -> Result<(Vec<u8>, bool), CryptoError> {
    let (&version, _) = sealed.split_first().ok_or(CryptoError::Tampered)?;
    if version != VERSION {
        return Err(CryptoError::NewerFormat);
    }
    if sealed.len() < HEADER_LEN + TAG_LEN {
        return Err(CryptoError::Tampered);
    }
    let flags = sealed[1];
    if flags & !FLAG_DEFLATED != 0 {
        return Err(CryptoError::Tampered);
    }
    let cipher = XChaCha20Poly1305::new(key.into());
    let plain = cipher
        .decrypt(XNonce::from_slice(&sealed[2..HEADER_LEN]), Payload { msg: &sealed[HEADER_LEN..], aad })
        .map_err(|_| CryptoError::Tampered)?;
    Ok((plain, flags & FLAG_DEFLATED != 0))
}

fn deflate(plain: &[u8]) -> Option<Vec<u8>> {
    let mut enc = DeflateEncoder::new(Vec::new(), Compression::default());
    enc.write_all(plain).ok()?;
    enc.finish().ok()
}

fn inflate(packed: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let mut out = Vec::new();
    // One byte past the cap tells "exactly at the cap" from "over it".
    let read = DeflateDecoder::new(packed).take(MAX_INFLATED + 1).read_to_end(&mut out);
    if read.is_err() || out.len() as u64 > MAX_INFLATED {
        return Err(CryptoError::Tampered);
    }
    Ok(out)
}

/// Seals a record or a page's text. Deflated only if that makes it smaller.
pub fn seal(keys: &VaultKeys, kind: &str, key: &str, plain: &[u8]) -> Vec<u8> {
    let aad = aad(kind, key);
    match deflate(plain) {
        Some(packed) if packed.len() < plain.len() => encrypt(&keys.records, &aad, FLAG_DEFLATED, &packed),
        _ => encrypt(&keys.records, &aad, 0, plain),
    }
}

pub fn open(keys: &VaultKeys, kind: &str, key: &str, sealed: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let (plain, deflated) = decrypt(&keys.records, &aad(kind, key), sealed)?;
    if deflated {
        inflate(&plain)
    } else {
        Ok(plain)
    }
}

/// A chunk of a file, never deflated (most files are already compressed).
pub fn seal_file_chunk(keys: &VaultKeys, blob_name: &str, plain: &[u8]) -> Vec<u8> {
    encrypt(&keys.files, &aad("f", blob_name), 0, plain)
}

pub fn open_file_chunk(keys: &VaultKeys, blob_name: &str, sealed: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let (plain, deflated) = decrypt(&keys.files, &aad("f", blob_name), sealed)?;
    // File chunks are never deflated; a flag saying so isn't ours.
    if deflated {
        return Err(CryptoError::Tampered);
    }
    Ok(plain)
}

// ---- Names the server sees ----

/// The first 16 bytes of HMAC-SHA256 of `name` under the names key.
fn name_hash(keys: &VaultKeys, name: &str) -> [u8; 16] {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&keys.names).expect("HMAC takes any key length");
    mac.update(name.as_bytes());
    let full = mac.finalize().into_bytes();
    let mut out = [0u8; 16];
    out.copy_from_slice(&full[..16]);
    out
}

/// What the server calls an item: `name` is `<entity>/<id>`, or `body/<page id>`.
pub fn item_key(keys: &VaultKeys, name: &str) -> String {
    base64url(&name_hash(keys, name))
}

/// What the server calls one chunk of a file.
pub fn blob_name(keys: &VaultKeys, stored: &str, chunk: u32) -> String {
    let hash = name_hash(keys, &format!("file/{stored}/{chunk}"));
    hash.iter().map(|b| format!("{b:02x}")).collect()
}

/// URL-safe base64 without padding.
pub(crate) fn base64url(bytes: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, &b)| n | (b as u32) << (16 - 8 * i));
        for i in 0..=chunk.len() {
            out.push(ABC[(n >> (18 - 6 * i) & 63) as usize] as char);
        }
    }
    out
}

pub(crate) fn unbase64url(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in text.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return None,
        };
        acc = acc << 6 | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    // Leftover bits must be the zero padding of a whole encoding.
    (bits < 6 && acc == 0).then_some(out)
}

// ---- The recovery key ----

const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RECOVERY_CHARS: usize = 30;

/// The 16 key bytes followed by the first 22 bits of their SHA-256: 150 bits, 30 characters.
fn recovery_bits(key: &[u8; 16]) -> [u8; 19] {
    let mut bits = [0u8; 19];
    bits[..16].copy_from_slice(key);
    bits[16..].copy_from_slice(&Sha256::digest(key)[..3]);
    bits[18] &= 0xFC;
    bits
}

/// The 5-bit group at position `i` of the 150 bits.
fn group(bits: &[u8; 19], i: usize) -> usize {
    let pos = i * 5;
    let pair = (bits[pos / 8] as u16) << 8 | bits.get(pos / 8 + 1).copied().unwrap_or(0) as u16;
    (pair >> (11 - pos % 8) & 31) as usize
}

/// Returns the key and how it is shown to the person: `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`.
pub fn new_recovery_key() -> ([u8; 16], String) {
    let key = random::<16>();
    let bits = recovery_bits(&key);
    let mut text = String::with_capacity(RECOVERY_CHARS + 5);
    for i in 0..RECOVERY_CHARS {
        if i > 0 && i % 5 == 0 {
            text.push('-');
        }
        text.push(CROCKFORD[group(&bits, i)] as char);
    }
    (key, text)
}

/// Accepts what a person might type: lower case, spaces and dashes anywhere,
/// I and L for 1, O for 0.
pub fn parse_recovery_key(typed: &str) -> Result<[u8; 16], CryptoError> {
    let mut bits = [0u8; 19];
    let mut count = 0;
    for c in typed.chars().filter(|c| !c.is_whitespace() && *c != '-') {
        let c = match c.to_ascii_uppercase() {
            'I' | 'L' => '1',
            'O' => '0',
            other => other,
        };
        let value = CROCKFORD.iter().position(|&a| a as char == c).ok_or(CryptoError::BadRecoveryKey)?;
        if count == RECOVERY_CHARS {
            return Err(CryptoError::BadRecoveryKey);
        }
        let pos = count * 5;
        let shifted = (value as u16) << (11 - pos % 8);
        bits[pos / 8] |= (shifted >> 8) as u8;
        if pos / 8 + 1 < bits.len() {
            bits[pos / 8 + 1] |= shifted as u8;
        }
        count += 1;
    }
    if count != RECOVERY_CHARS {
        return Err(CryptoError::BadRecoveryKey);
    }
    let mut key = [0u8; 16];
    key.copy_from_slice(&bits[..16]);
    if recovery_bits(&key) != bits {
        return Err(CryptoError::BadRecoveryKey);
    }
    Ok(key)
}

// ---- Wrapping the vault key for the server ----

/// What the server keeps: the vault key sealed with a key made from the recovery key.
pub fn wrap_vault_key(recovery: &[u8; 16], vault_key: &[u8; 32]) -> String {
    let wrapping = derive(recovery, b"td sync recovery v1");
    base64url(&encrypt(&wrapping, WRAP_AAD, 0, vault_key))
}

/// A wrong recovery key and a damaged wrapper look the same: `BadRecoveryKey`.
pub fn unwrap_vault_key(recovery: &[u8; 16], wrapped: &str) -> Result<[u8; 32], CryptoError> {
    let sealed = unbase64url(wrapped).ok_or(CryptoError::Tampered)?;
    let wrapping = derive(recovery, b"td sync recovery v1");
    let (plain, _) = decrypt(&wrapping, WRAP_AAD, &sealed).map_err(|e| match e {
        CryptoError::Tampered => CryptoError::BadRecoveryKey,
        other => other,
    })?;
    plain.try_into().map_err(|_| CryptoError::Tampered)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys() -> VaultKeys {
        VaultKeys::from_vault_key(&[7u8; 32])
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn unhex(text: &str) -> Vec<u8> {
        (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap()).collect()
    }

    #[test]
    fn round_trips() {
        let k = keys();
        let text = "a line of notes\n".repeat(10 * 1024 * 1024 / 16);
        let noise: [u8; 100] = random();
        let noise = noise.repeat(1000);
        let noise: Vec<u8> = noise.iter().enumerate().map(|(i, b)| b ^ (i as u8).wrapping_mul(131)).collect();
        for plain in [&b""[..], b"x", text.as_bytes(), &noise] {
            let sealed = seal(&k, "r", "key", plain);
            assert_eq!(open(&k, "r", "key", &sealed).unwrap(), plain);
        }
        let big = seal(&k, "y", "k", text.as_bytes());
        assert_eq!(big[1], FLAG_DEFLATED);
        assert!(big.len() < text.len() / 10);
        let mut truly_random = vec![0u8; 100_000];
        getrandom::getrandom(&mut truly_random).unwrap();
        let sealed = seal(&k, "r", "k", &truly_random);
        assert_eq!(sealed[1], 0, "random bytes aren't deflated");
        assert_eq!(sealed.len(), HEADER_LEN + truly_random.len() + TAG_LEN);
        assert_eq!(open(&k, "r", "k", &sealed).unwrap(), truly_random);
    }

    #[test]
    fn two_seals_differ() {
        let k = keys();
        let (a, b) = (seal(&k, "r", "k", b"same"), seal(&k, "r", "k", b"same"));
        assert_ne!(a, b);
        assert_ne!(a[2..HEADER_LEN], b[2..HEADER_LEN], "a fresh nonce each time");
    }

    #[test]
    fn rejects_a_changed_kind_or_key() {
        let k = keys();
        let sealed = seal(&k, "r", "key", b"hello");
        assert_eq!(open(&k, "y", "key", &sealed), Err(CryptoError::Tampered));
        assert_eq!(open(&k, "r", "other", &sealed), Err(CryptoError::Tampered));
        let other = VaultKeys::from_vault_key(&[8u8; 32]);
        assert_eq!(open(&other, "r", "key", &sealed), Err(CryptoError::Tampered));
    }

    #[test]
    fn rejects_any_flipped_byte() {
        let k = keys();
        let sealed = seal(&k, "r", "key", b"hello there, a few bytes to flip");
        for i in 1..sealed.len() {
            let mut bad = sealed.clone();
            bad[i] ^= 1;
            assert_eq!(open(&k, "r", "key", &bad), Err(CryptoError::Tampered), "byte {i}");
        }
        // The version byte is a different answer: it asks for an update.
        let mut bad = sealed.clone();
        bad[0] ^= 1;
        assert_eq!(open(&k, "r", "key", &bad), Err(CryptoError::NewerFormat));
    }

    #[test]
    fn rejects_short_and_empty_envelopes() {
        let k = keys();
        let sealed = seal(&k, "r", "key", b"");
        assert_eq!(sealed.len(), HEADER_LEN + TAG_LEN);
        assert!(open(&k, "r", "key", &sealed).is_ok());
        for n in 0..sealed.len() {
            assert!(open(&k, "r", "key", &sealed[..n]).is_err(), "length {n}");
        }
        assert_eq!(open(&k, "r", "key", &[]), Err(CryptoError::Tampered));
        assert_eq!(open_file_chunk(&k, "n", &sealed[..10]), Err(CryptoError::Tampered));
    }

    #[test]
    fn a_newer_version_asks_for_an_update() {
        let k = keys();
        let mut sealed = seal(&k, "r", "key", b"hello");
        sealed[0] = 2;
        let err = open(&k, "r", "key", &sealed).unwrap_err();
        assert_eq!(err, CryptoError::NewerFormat);
        assert_eq!(err.to_string(), "Update Thought Desk to keep syncing");
        sealed[0] = 0;
        assert_eq!(open(&k, "r", "key", &sealed), Err(CryptoError::NewerFormat));
        sealed.truncate(1);
        assert_eq!(open(&k, "r", "key", &sealed), Err(CryptoError::NewerFormat));
    }

    #[test]
    fn a_bomb_is_refused() {
        let k = keys();
        // 65 MiB of zeros packs small: sealed honestly, it still mustn't open.
        let packed = deflate(&vec![0u8; 65 * 1024 * 1024]).unwrap();
        assert!(packed.len() < 200_000);
        let sealed = encrypt(&k.records, &aad("r", "k"), FLAG_DEFLATED, &packed);
        assert_eq!(open(&k, "r", "k", &sealed), Err(CryptoError::Tampered));
        // Exactly at the cap is fine.
        let packed = deflate(&vec![0u8; MAX_INFLATED as usize]).unwrap();
        let sealed = encrypt(&k.records, &aad("r", "k"), FLAG_DEFLATED, &packed);
        assert_eq!(open(&k, "r", "k", &sealed).unwrap().len(), MAX_INFLATED as usize);
        // Not deflate data at all.
        let sealed = encrypt(&k.records, &aad("r", "k"), FLAG_DEFLATED, &[0xFF; 50]);
        assert_eq!(open(&k, "r", "k", &sealed), Err(CryptoError::Tampered));
    }

    #[test]
    fn file_chunks_round_trip_and_stay_apart() {
        let k = keys();
        let name = blob_name(&k, "abc.png", 0);
        let sealed = seal_file_chunk(&k, &name, &[0u8; 5000]);
        assert_eq!(sealed.len(), HEADER_LEN + 5000 + TAG_LEN, "never deflated");
        assert_eq!(open_file_chunk(&k, &name, &sealed).unwrap(), vec![0u8; 5000]);
        assert!(open_file_chunk(&k, &blob_name(&k, "abc.png", 1), &sealed).is_err());
        // A record can't pass for a file chunk, nor the other way round.
        assert!(open(&k, "f", &name, &sealed).is_err());
        let record = seal(&k, "f", &name, b"x");
        assert!(open_file_chunk(&k, &name, &record).is_err());
    }

    #[test]
    fn names_are_deterministic_and_shaped() {
        let k = keys();
        let a = item_key(&k, "note/123");
        assert_eq!(a, item_key(&k, "note/123"));
        assert_ne!(a, item_key(&k, "note/124"));
        assert_ne!(a, item_key(&VaultKeys::from_vault_key(&[8u8; 32]), "note/123"));
        assert_eq!(a.len(), 22);
        assert!(a.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
        let b = blob_name(&k, "x.png", 3);
        assert_eq!(b, blob_name(&k, "x.png", 3));
        assert_ne!(b, blob_name(&k, "x.png", 4));
        assert_eq!(b.len(), 32);
        assert!(b.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)));
    }

    #[test]
    fn base64url_round_trips() {
        for n in 0..40u8 {
            let bytes: Vec<u8> = (0..n).map(|i| i.wrapping_mul(37).wrapping_add(250)).collect();
            assert_eq!(unbase64url(&base64url(&bytes)).unwrap(), bytes);
        }
        assert_eq!(base64url(&[0xFB, 0xFF]), "-_8");
        assert!(unbase64url("ab=").is_none());
        assert!(unbase64url("a").is_none());
        assert!(unbase64url("abc+").is_none());
    }

    #[test]
    fn recovery_key_round_trips_with_messy_typing() {
        let (key, shown) = new_recovery_key();
        assert_eq!(shown.len(), 35);
        assert!(shown.split('-').count() == 6 && shown.split('-').all(|g| g.len() == 5));
        assert_eq!(parse_recovery_key(&shown).unwrap(), key);
        let messy = format!("  {}  ", shown.to_lowercase().replace('-', " - "));
        assert_eq!(parse_recovery_key(&messy).unwrap(), key);
        assert_eq!(parse_recovery_key(&shown.replace('-', "")).unwrap(), key);
    }

    #[test]
    fn recovery_key_reads_i_l_and_o_as_digits() {
        // A key whose text has plenty of 0s and 1s: all-zero bytes, checksum aside.
        let bits = recovery_bits(&[0u8; 16]);
        // SHA-256 of 16 zero bytes starts 37 47 08 (0x374708) (checked with Node); the last 2 bits are dropped.
        assert_eq!(bits[16..], [0x37, 0x47, 0x08]);
        let text: String = (0..RECOVERY_CHARS).map(|i| CROCKFORD[group(&bits, i)] as char).collect();
        assert!(text.starts_with("0000000000000000000000000"));
        assert_eq!(parse_recovery_key(&text).unwrap(), [0u8; 16]);
        let typed = text.replace('0', "o").replace('1', "l");
        assert_eq!(parse_recovery_key(&typed).unwrap(), [0u8; 16]);
        let typed = text.replace('0', "O").replace('1', "I");
        assert_eq!(parse_recovery_key(&typed).unwrap(), [0u8; 16]);
        assert_eq!(parse_recovery_key("00000-00000-00000-00000-00000-00000"), Err(CryptoError::BadRecoveryKey));
    }

    #[test]
    fn recovery_key_rejects_mistakes() {
        let (_, shown) = new_recovery_key();
        let plain: String = shown.replace('-', "");
        assert!(parse_recovery_key("").is_err());
        assert!(parse_recovery_key(&plain[..29]).is_err());
        assert!(parse_recovery_key(&format!("{plain}0")).is_err());
        assert!(parse_recovery_key(&format!("{}U", &plain[..29])).is_err(), "U isn't in the alphabet");
        assert!(parse_recovery_key(&format!("{}!", &plain[..29])).is_err());
        assert!(parse_recovery_key(&format!("{}\u{e9}", &plain[..29])).is_err());
        // Any single changed character is caught by the checksum.
        for i in 0..RECOVERY_CHARS {
            let mut chars: Vec<char> = plain.chars().collect();
            let at = CROCKFORD.iter().position(|&a| a as char == chars[i]).unwrap();
            chars[i] = CROCKFORD[(at + 1) % 32] as char;
            let bad: String = chars.into_iter().collect();
            assert_eq!(parse_recovery_key(&bad), Err(CryptoError::BadRecoveryKey), "char {i}");
        }
    }

    #[test]
    fn the_vault_key_wraps_and_unwraps() {
        let vault = new_vault_key();
        let (recovery, _) = new_recovery_key();
        let wrapped = wrap_vault_key(&recovery, &vault);
        assert_ne!(wrapped, wrap_vault_key(&recovery, &vault));
        assert_eq!(unwrap_vault_key(&recovery, &wrapped).unwrap(), vault);
        let (other, _) = new_recovery_key();
        assert_eq!(unwrap_vault_key(&other, &wrapped), Err(CryptoError::BadRecoveryKey));
        assert_eq!(unwrap_vault_key(&recovery, "not base64 !"), Err(CryptoError::Tampered));
        assert_eq!(unwrap_vault_key(&recovery, ""), Err(CryptoError::BadRecoveryKey));
        assert_eq!(unwrap_vault_key(&recovery, &wrapped[..20]), Err(CryptoError::BadRecoveryKey));
    }

    #[test]
    fn derivation_matches_known_answers() {
        // Worked out independently with Node's crypto (hkdfSync and createHmac).
        let k = VaultKeys::from_vault_key(&[7u8; 32]);
        assert_eq!(hex(&k.records), "9917b81615cf69568586bc1cc71c263ce3c28f5b5ddb7db68870d212a73271f2");
        assert_eq!(hex(&k.names), "a8398d8f37847aba74e195ac0887030cf0d354c70904d7bd7a89f8e2ac653cbb");
        assert_eq!(hex(&k.files), "9a0cb4ea5cecca1d2fb5743d5f490653dd6152635157013ecc926bcdb3862b44");
        assert_eq!(hex(&derive(&[9u8; 16], b"td sync recovery v1")), "2c4b2f2d8e34cced85bf5b122c7a7b84d1b7589a892f5ceb40254b436133756f");
        // The proof, the same way: HKDF-SHA256 of the vault key, no salt, info "td sync proof v1".
        assert_eq!(hex(&vault_proof(&k)), "b12fc3af16329230be58f350d61382688dcaa222fda3b7cec89d391c4c7bd75d");
        assert_ne!(vault_proof(&k), k.records, "each purpose has its own key");
        assert_ne!(vault_proof(&k), vault_proof(&VaultKeys::from_vault_key(&[8u8; 32])));
        assert_eq!(item_key(&k, "note/123"), "mMSy_RzGdbYUGnfBiGrocw");
        assert_eq!(blob_name(&k, "abc.png", 2), "0669e55a1b17922608ab8975a0f5d15b");
    }

    #[test]
    fn an_envelope_from_today_opens_forever() {
        let k = keys();
        let sealed = unhex(FROZEN_RECORD);
        assert_eq!(open(&k, "r", "frozen-key", &sealed).unwrap(), FROZEN_PLAIN.as_bytes());
        let sealed = unhex(FROZEN_DEFLATED);
        assert_eq!(sealed[1], FLAG_DEFLATED);
        assert_eq!(open(&k, "y", "frozen-key", &sealed).unwrap(), FROZEN_PLAIN.repeat(20).as_bytes());
        let sealed = unhex(FROZEN_CHUNK);
        assert_eq!(open_file_chunk(&k, "frozen-blob", &sealed).unwrap(), b"file bytes");
        assert_eq!(unwrap_vault_key(&[9u8; 16], FROZEN_WRAPPED).unwrap(), [7u8; 32]);
    }

    const FROZEN_PLAIN: &str = "Thought Desk sealed envelope, format 1.";
    const FROZEN_RECORD: &str = "0100c60960f94daed77439e2ecb2ea4c96359c6761395b68549cf02925b34baf669e784a01a793886b1753c6065b0dd2ad818c3ba14df9db2e66bccd95d0d04c17771726004e69cacd5559be8d0e87fa61";
    const FROZEN_DEFLATED: &str = "01012e4cc9dc24cde702f9ee0de0bd9b2a8ef893b0f866b64d015988910e6191453b492ad00ffbdbb92d171f49c50f8d844da6e02bb67a029fe4800204a43c46b3e93e79413a82ee2a44747fefac1d7454f926e4f4110f386699f3ac418ecc2d0b83";
    const FROZEN_CHUNK: &str = "010066b947ea9a0aba288c9209afd015733450a4158d4d1bdbfaea9778a15bc59880a307bef6bd3cc5be94002dd3038292188e03";
    const FROZEN_WRAPPED: &str = "AQAKVGew3kgc7jXQwX0Z6DmWCPC6lFKGjAXxxbjAVs_NdOhTOrrsZ13ThkbRIEPL9yR0byr4lqH377o5zo_N68-hATqOtdjmm74";
}
