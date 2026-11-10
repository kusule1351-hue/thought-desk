//! The hybrid logical clock. A stamp is wall-clock milliseconds, a counter
//! for changes in the same millisecond, and this copy's device id, written
//! so that comparing two stamps as strings orders changes in time.
//! `docs/sync.md` has the design.

use crate::db::{now, Result};
use rusqlite::{Connection, OptionalExtension};

#[cfg(test)]
mod convergence;
pub(crate) mod crypto;
pub(crate) mod files;
pub(crate) mod order;
pub(crate) mod records;
pub(crate) mod setup;
#[cfg(test)]
mod testkit;
pub(crate) mod text;
pub(crate) mod vault;

/// This copy's name in its stamps: the install's, if it's been told, or else
/// the one made with the database. A notes folder that's copied or on a cloud
/// drive would otherwise make two computers one.
pub(crate) fn device(conn: &Connection) -> Result<String> {
    Ok(conn.query_row(
        "SELECT value FROM sync_meta WHERE key IN ('install', 'device') ORDER BY key = 'install' DESC LIMIT 1",
        [],
        |r| r.get(0),
    )?)
}

/// (milliseconds, counter) of a stamp; (0, 0) for none.
pub(crate) fn parse(stamp: &str) -> (i64, i64) {
    let mut parts = stamp.splitn(3, '-');
    let ms = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    let n = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    (ms, n)
}

pub(crate) fn make(ms: i64, n: i64, device: &str) -> String {
    let short: String = device.chars().filter(|c| c.is_ascii_hexdigit()).take(8).collect();
    format!("{ms:013}-{n:04}-{short}")
}

fn last(conn: &Connection) -> Result<String> {
    Ok(conn
        .query_row("SELECT value FROM sync_meta WHERE key = 'clock'", [], |r| r.get(0))
        .optional()?
        .unwrap_or_default())
}

fn store(conn: &Connection, stamp: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO sync_meta (key, value) VALUES ('clock', ?1)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        [stamp],
    )?;
    Ok(())
}

/// The latest time a stamp can hold: 13 digits. Past it a stamp would have
/// 14, and sort below every other.
const LAST_MS: i64 = 9_999_999_999_999;

/// A new stamp, later than every stamp this copy has made or seen.
pub(crate) fn tick(conn: &Connection) -> Result<String> {
    let (last_ms, last_n) = parse(&last(conn)?);
    let mut ms = now().max(last_ms).min(LAST_MS);
    let mut n = if ms == last_ms { last_n + 1 } else { 0 };
    if n > 9999 {
        if ms < LAST_MS {
            ms += 1;
            n = 0;
        } else {
            n = 9999;
        }
    }
    let stamp = make(ms, n, &device(conn)?);
    store(conn, &stamp)?;
    Ok(stamp)
}

/// Takes note of a stamp from another copy, so the next local change is
/// stamped later than it (even if this computer's clock is behind).
pub(crate) fn observe(conn: &Connection, stamp: &str) -> Result<()> {
    if stamp > last(conn)?.as_str() {
        let (ms, n) = parse(stamp);
        store(conn, &make(ms, n, &device(conn)?))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stamps_order_as_text() {
        let a = make(1_700_000_000_000, 3, "0f3c9a2e-aaaa");
        let b = make(1_700_000_000_000, 12, "00000000");
        let c = make(1_700_000_000_001, 0, "00000000");
        assert!(a < b && b < c);
        assert_eq!(parse(&b), (1_700_000_000_000, 12));
        assert_eq!(parse(""), (0, 0));
    }
}
