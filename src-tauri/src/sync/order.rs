//! Order keys: strings that sort in the order things are shown, so moving a
//! row between two others gives it a key between theirs and nothing else is
//! renumbered (two computers reordering at once can't overwrite each other).
//!
//! This is a port of `src/lib/db/order.ts` and must give the same key for the
//! same input. A key is a variable-length "integer" part (its first letter
//! says how long it is) followed by an optional fraction, in base 62.
//!
//! Keys arrive from other computers, so nothing here panics on bad input:
//! keys that aren't well formed (or aren't in order) count as open ends.

const DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ZERO: u8 = b'0';
const LAST: u8 = b'z';
const BASE: i32 = 62;

/// Where a digit sits in `DIGITS` (-1 when it isn't one).
fn digit_index(c: u8) -> i32 {
    DIGITS.iter().position(|&d| d == c).map_or(-1, |i| i as i32)
}

fn digit(i: i32) -> u8 {
    usize::try_from(i).ok().and_then(|i| DIGITS.get(i)).copied().unwrap_or(ZERO)
}

/// 'A' followed by 26 zeros: the smallest integer part, so nothing sorts before it.
fn is_smallest_int(key: &[u8]) -> bool {
    key.len() == 27 && key[0] == b'A' && key[1..].iter().all(|&c| c == ZERO)
}

/// How long the integer part is, from its first letter.
fn int_length(head: u8) -> Option<usize> {
    match head {
        b'a'..=b'z' => Some((head - b'a') as usize + 2),
        b'A'..=b'Z' => Some((b'Z' - head) as usize + 2),
        _ => None,
    }
}

fn int_length_of(key: &[u8]) -> Option<usize> {
    let n = int_length(*key.first()?)?;
    (n <= key.len()).then_some(n)
}

/// The integer part and the fraction. Only called on keys that passed `valid_key`.
fn split(key: &[u8]) -> (&[u8], &[u8]) {
    key.split_at(int_length_of(key).unwrap_or(key.len()))
}

fn join(a: &[u8], b: &[u8]) -> Vec<u8> {
    [a, b].concat()
}

/// A fraction between a and b (a < b); b may be open.
fn midpoint(mut a: &[u8], mut b: Option<&[u8]>) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        if let Some(bb) = b {
            // Whatever the two share stays as it is (a missing digit counts as zero).
            let mut n = 0;
            while Some(a.get(n).copied().unwrap_or(ZERO)) == bb.get(n).copied() {
                n += 1;
            }
            if n > 0 {
                out.extend_from_slice(&bb[..n]);
                a = &a[n.min(a.len())..];
                b = Some(&bb[n..]);
                continue;
            }
        }
        let da = a.first().map_or(0, |&c| digit_index(c));
        let db = match b {
            Some(bb) => bb.first().map_or(-1, |&c| digit_index(c)),
            None => BASE,
        };
        if db - da > 1 {
            out.push(digit((da + db + 1).div_euclid(2)));
            return out;
        }
        if let Some(&first) = b.filter(|bb| bb.len() > 1).and_then(|bb| bb.first()) {
            out.push(first);
            return out;
        }
        out.push(digit(da));
        a = a.get(1..).unwrap_or_default();
        b = None;
    }
}

/// The next integer part up, or None when it is already the largest.
fn increment(x: &[u8]) -> Option<Vec<u8>> {
    let (&head, digs) = x.split_first()?;
    let mut digs = digs.to_vec();
    let mut carry = true;
    for d in digs.iter_mut().rev() {
        let next = digit_index(*d) + 1;
        if next == BASE {
            *d = ZERO;
        } else {
            *d = digit(next);
            carry = false;
            break;
        }
    }
    if !carry {
        return Some(join(&[head], &digs));
    }
    if head == b'Z' {
        return Some(vec![b'a', ZERO]);
    }
    if head == LAST {
        return None;
    }
    let h = head.wrapping_add(1);
    if h > b'a' {
        digs.push(ZERO);
    } else {
        digs.pop();
    }
    Some(join(&[h], &digs))
}

/// The next integer part down, or None when it is already the smallest.
fn decrement(x: &[u8]) -> Option<Vec<u8>> {
    let (&head, digs) = x.split_first()?;
    let mut digs = digs.to_vec();
    let mut borrow = true;
    for d in digs.iter_mut().rev() {
        let prev = digit_index(*d) - 1;
        if prev == -1 {
            *d = LAST;
        } else {
            *d = digit(prev);
            borrow = false;
            break;
        }
    }
    if !borrow {
        return Some(join(&[head], &digs));
    }
    if head == b'a' {
        return Some(vec![b'Z', LAST]);
    }
    if head == b'A' {
        return None;
    }
    let h = head.wrapping_sub(1);
    if h < b'Z' {
        digs.push(LAST);
    } else {
        digs.pop();
    }
    Some(join(&[h], &digs))
}

/// Whether a key is well formed (keys from elsewhere are checked first).
pub(crate) fn valid_key(key: &str) -> bool {
    let key = key.as_bytes();
    if key.is_empty() || is_smallest_int(key) {
        return false;
    }
    let Some(n) = int_length_of(key) else {
        return false;
    };
    // A fraction never ends in zero, so every position has just one spelling.
    key.iter().all(|c| DIGITS.contains(c)) && key[n..].last() != Some(&ZERO)
}

fn before(b: &[u8]) -> Vec<u8> {
    let (ib, fb) = split(b);
    if is_smallest_int(ib) {
        return join(ib, &midpoint(&[], Some(fb)));
    }
    if !fb.is_empty() {
        return ib.to_vec();
    }
    decrement(ib).unwrap_or_else(|| join(ib, &midpoint(&[], Some(fb))))
}

fn after(a: &[u8]) -> Vec<u8> {
    let (ia, fa) = split(a);
    increment(ia).unwrap_or_else(|| join(ia, &midpoint(fa, None)))
}

fn between(a: &[u8], b: &[u8]) -> Vec<u8> {
    let (ia, fa) = split(a);
    let (ib, fb) = split(b);
    if ia == ib {
        return join(ia, &midpoint(fa, Some(fb)));
    }
    match increment(ia) {
        Some(i) if i.as_slice() < b => i,
        _ => join(ia, &midpoint(fa, None)),
    }
}

/// A key that sorts after `a` and before `b` (None: the start or the end).
/// Keys that aren't well formed (or not in order) are treated as open ends.
pub(crate) fn key_between(a: Option<&str>, b: Option<&str>) -> String {
    let a = a.filter(|k| valid_key(k));
    let mut b = b.filter(|k| valid_key(k));
    if matches!((a, b), (Some(x), Some(y)) if x >= y) {
        b = None;
    }
    let key = match (a, b) {
        (None, None) => vec![b'a', ZERO],
        (None, Some(b)) => before(b.as_bytes()),
        (Some(a), None) => after(a.as_bytes()),
        (Some(a), Some(b)) => between(a.as_bytes(), b.as_bytes()),
    };
    String::from_utf8(key).unwrap_or_default()
}

/// `n` keys in order between a and b (for pasting or importing many rows).
pub(crate) fn keys_between(a: Option<&str>, b: Option<&str>, n: usize) -> Vec<String> {
    if n == 0 {
        return Vec::new();
    }
    if b.is_none() {
        let mut out: Vec<String> = Vec::with_capacity(n);
        for _ in 0..n {
            let next = key_between(out.last().map(String::as_str).or(a), None);
            out.push(next);
        }
        return out;
    }
    if n == 1 {
        return vec![key_between(a, b)];
    }
    // Split the gap in half, then fill each side.
    let mid = key_between(a, b);
    let left = (n - 1) / 2;
    let mut out = keys_between(a, Some(&mid), left);
    out.push(mid.clone());
    out.extend(keys_between(Some(&mid), b, n - 1 - left));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // Each row was produced by running order.ts on the same inputs.
    #[rustfmt::skip]
    const KEY_BETWEEN_CASES: &[(Option<&str>, Option<&str>, &str)] = &[
        (None, None, "a0"),
        (Some("a0"), None, "a1"),
        (Some("a1"), None, "a2"),
        (Some("a2"), None, "a3"),
        (Some("a3"), None, "a4"),
        (Some("a4"), None, "a5"),
        (Some("a5"), None, "a6"),
        (Some("a6"), None, "a7"),
        (Some("a7"), None, "a8"),
        (Some("a8"), None, "a9"),
        (Some("a9"), None, "aA"),
        (Some("aA"), None, "aB"),
        (Some("aB"), None, "aC"),
        (Some("aC"), None, "aD"),
        (Some("aD"), None, "aE"),
        (Some("aE"), None, "aF"),
        (Some("aF"), None, "aG"),
        (Some("aG"), None, "aH"),
        (Some("aH"), None, "aI"),
        (Some("aI"), None, "aJ"),
        (Some("aJ"), None, "aK"),
        (Some("aK"), None, "aL"),
        (Some("aL"), None, "aM"),
        (Some("aM"), None, "aN"),
        (Some("aN"), None, "aO"),
        (Some("aO"), None, "aP"),
        (Some("aP"), None, "aQ"),
        (Some("aQ"), None, "aR"),
        (Some("aR"), None, "aS"),
        (Some("aS"), None, "aT"),
        (Some("aT"), None, "aU"),
        (Some("aU"), None, "aV"),
        (Some("aV"), None, "aW"),
        (Some("aW"), None, "aX"),
        (Some("aX"), None, "aY"),
        (Some("aY"), None, "aZ"),
        (Some("aZ"), None, "aa"),
        (Some("aa"), None, "ab"),
        (Some("ab"), None, "ac"),
        (Some("ac"), None, "ad"),
        (Some("ad"), None, "ae"),
        (Some("ae"), None, "af"),
        (Some("af"), None, "ag"),
        (Some("ag"), None, "ah"),
        (Some("ah"), None, "ai"),
        (Some("ai"), None, "aj"),
        (Some("aj"), None, "ak"),
        (Some("ak"), None, "al"),
        (Some("al"), None, "am"),
        (Some("am"), None, "an"),
        (Some("an"), None, "ao"),
        (Some("ao"), None, "ap"),
        (Some("ap"), None, "aq"),
        (Some("aq"), None, "ar"),
        (Some("ar"), None, "as"),
        (Some("as"), None, "at"),
        (Some("at"), None, "au"),
        (Some("au"), None, "av"),
        (Some("av"), None, "aw"),
        (Some("aw"), None, "ax"),
        (Some("ax"), None, "ay"),
        (Some("ay"), None, "az"),
        (Some("az"), None, "b00"),
        (Some("b00"), None, "b01"),
        (Some("b01"), None, "b02"),
        (Some("b02"), None, "b03"),
        (Some("b03"), None, "b04"),
        (Some("b04"), None, "b05"),
        (Some("b05"), None, "b06"),
        (Some("b06"), None, "b07"),
        (None, None, "a0"),
        (None, Some("a0"), "Zz"),
        (None, Some("Zz"), "Zy"),
        (None, Some("Zy"), "Zx"),
        (None, Some("Zx"), "Zw"),
        (None, Some("Zw"), "Zv"),
        (None, Some("Zv"), "Zu"),
        (None, Some("Zu"), "Zt"),
        (None, Some("Zt"), "Zs"),
        (None, Some("Zs"), "Zr"),
        (None, Some("Zr"), "Zq"),
        (None, Some("Zq"), "Zp"),
        (None, Some("Zp"), "Zo"),
        (None, Some("Zo"), "Zn"),
        (None, Some("Zn"), "Zm"),
        (None, Some("Zm"), "Zl"),
        (None, Some("Zl"), "Zk"),
        (None, Some("Zk"), "Zj"),
        (None, Some("Zj"), "Zi"),
        (None, Some("Zi"), "Zh"),
        (None, Some("Zh"), "Zg"),
        (None, Some("Zg"), "Zf"),
        (None, Some("Zf"), "Ze"),
        (None, Some("Ze"), "Zd"),
        (None, Some("Zd"), "Zc"),
        (None, Some("Zc"), "Zb"),
        (None, Some("Zb"), "Za"),
        (None, Some("Za"), "ZZ"),
        (None, Some("ZZ"), "ZY"),
        (None, Some("ZY"), "ZX"),
        (None, Some("ZX"), "ZW"),
        (None, Some("ZW"), "ZV"),
        (None, Some("ZV"), "ZU"),
        (None, Some("ZU"), "ZT"),
        (None, Some("ZT"), "ZS"),
        (None, Some("ZS"), "ZR"),
        (None, Some("ZR"), "ZQ"),
        (None, Some("ZQ"), "ZP"),
        (None, Some("ZP"), "ZO"),
        (None, Some("ZO"), "ZN"),
        (None, Some("ZN"), "ZM"),
        (None, Some("ZM"), "ZL"),
        (None, Some("ZL"), "ZK"),
        (None, Some("ZK"), "ZJ"),
        (None, Some("ZJ"), "ZI"),
        (None, Some("ZI"), "ZH"),
        (None, Some("ZH"), "ZG"),
        (None, Some("ZG"), "ZF"),
        (None, Some("ZF"), "ZE"),
        (None, Some("ZE"), "ZD"),
        (None, Some("ZD"), "ZC"),
        (None, Some("ZC"), "ZB"),
        (None, Some("ZB"), "ZA"),
        (None, Some("ZA"), "Z9"),
        (None, Some("Z9"), "Z8"),
        (None, Some("Z8"), "Z7"),
        (None, Some("Z7"), "Z6"),
        (None, Some("Z6"), "Z5"),
        (None, Some("Z5"), "Z4"),
        (None, Some("Z4"), "Z3"),
        (None, Some("Z3"), "Z2"),
        (None, Some("Z2"), "Z1"),
        (None, Some("Z1"), "Z0"),
        (None, Some("Z0"), "Yzz"),
        (None, Some("Yzz"), "Yzy"),
        (None, Some("Yzy"), "Yzx"),
        (None, Some("Yzx"), "Yzw"),
        (None, Some("Yzw"), "Yzv"),
        (None, Some("Yzv"), "Yzu"),
        (None, Some("Yzu"), "Yzt"),
        (Some("a0"), Some("a1"), "a0V"),
        (Some("a0V"), Some("a1"), "a0l"),
        (Some("a0l"), Some("a1"), "a0t"),
        (Some("a0t"), Some("a1"), "a0x"),
        (Some("a0x"), Some("a1"), "a0z"),
        (Some("a0z"), Some("a1"), "a0zV"),
        (Some("a0zV"), Some("a1"), "a0zl"),
        (Some("a0zl"), Some("a1"), "a0zt"),
        (Some("a0zt"), Some("a1"), "a0zx"),
        (Some("a0zx"), Some("a1"), "a0zz"),
        (Some("a0zz"), Some("a1"), "a0zzV"),
        (Some("a0zzV"), Some("a1"), "a0zzl"),
        (Some("a0zzl"), Some("a1"), "a0zzt"),
        (Some("a0zzt"), Some("a1"), "a0zzx"),
        (Some("a0zzx"), Some("a1"), "a0zzz"),
        (Some("a0zzz"), Some("a1"), "a0zzzV"),
        (Some("a0zzzV"), Some("a1"), "a0zzzl"),
        (Some("a0zzzl"), Some("a1"), "a0zzzt"),
        (Some("a0zzzt"), Some("a1"), "a0zzzx"),
        (Some("a0zzzx"), Some("a1"), "a0zzzz"),
        (Some("a0zzzz"), Some("a1"), "a0zzzzV"),
        (Some("a0zzzzV"), Some("a1"), "a0zzzzl"),
        (Some("a0zzzzl"), Some("a1"), "a0zzzzt"),
        (Some("a0zzzzt"), Some("a1"), "a0zzzzx"),
        (Some("a0zzzzx"), Some("a1"), "a0zzzzz"),
        (Some("a0"), Some("a1"), "a0V"),
        (Some("a0"), Some("a0V"), "a0G"),
        (Some("a0"), Some("a0G"), "a08"),
        (Some("a0"), Some("a08"), "a04"),
        (Some("a0"), Some("a04"), "a02"),
        (Some("a0"), Some("a02"), "a01"),
        (Some("a0"), Some("a01"), "a00V"),
        (Some("a0"), Some("a00V"), "a00G"),
        (Some("a0"), Some("a00G"), "a008"),
        (Some("a0"), Some("a008"), "a004"),
        (Some("a0"), Some("a004"), "a002"),
        (Some("a0"), Some("a002"), "a001"),
        (Some("a0"), Some("a001"), "a000V"),
        (Some("a0"), Some("a000V"), "a000G"),
        (Some("a0"), Some("a000G"), "a0008"),
        (Some("a0"), Some("a0008"), "a0004"),
        (Some("a0"), Some("a0004"), "a0002"),
        (Some("a0"), Some("a0002"), "a0001"),
        (Some("a0"), Some("a0001"), "a0000V"),
        (Some("a0"), Some("a0000V"), "a0000G"),
        (Some("a0"), Some("a0000G"), "a00008"),
        (Some("a0"), Some("a00008"), "a00004"),
        (Some("a0"), Some("a00004"), "a00002"),
        (Some("a0"), Some("a00002"), "a00001"),
        (Some("a0"), Some("a00001"), "a00000V"),
        (Some("a0"), Some("a1"), "a0V"),
        (Some("a0"), Some("a0V"), "a0G"),
        (Some("a0G"), Some("a0V"), "a0O"),
        (Some("a0G"), Some("a0O"), "a0K"),
        (Some("a0K"), Some("a0O"), "a0M"),
        (Some("a0K"), Some("a0M"), "a0L"),
        (Some("a0L"), Some("a0M"), "a0LV"),
        (Some("a0L"), Some("a0LV"), "a0LG"),
        (Some("a0LG"), Some("a0LV"), "a0LO"),
        (Some("a0LG"), Some("a0LO"), "a0LK"),
        (Some("a0LK"), Some("a0LO"), "a0LM"),
        (Some("a0LK"), Some("a0LM"), "a0LL"),
        (Some("a0LL"), Some("a0LM"), "a0LLV"),
        (Some("a0LL"), Some("a0LLV"), "a0LLG"),
        (Some("a0LLG"), Some("a0LLV"), "a0LLO"),
        (Some("a0LLG"), Some("a0LLO"), "a0LLK"),
        (Some("a0LLK"), Some("a0LLO"), "a0LLM"),
        (Some("a0LLK"), Some("a0LLM"), "a0LLL"),
        (Some("a0LLL"), Some("a0LLM"), "a0LLLV"),
        (Some("a0LLL"), Some("a0LLLV"), "a0LLLG"),
        (Some("az"), None, "b00"),
        (None, Some("az"), "ay"),
        (Some("zz"), None, "a0"),
        (None, Some("zz"), "a0"),
        (Some("Zz"), None, "a0"),
        (None, Some("Zz"), "Zy"),
        (Some("Y0"), None, "a0"),
        (None, Some("Y0"), "a0"),
        (Some("b00"), None, "b01"),
        (None, Some("b00"), "az"),
        (Some("a0V"), None, "a1"),
        (None, Some("a0V"), "a0"),
        (Some("zzzzzzzzzzzzzzzzzzzzzzzzzzz"), None, "zzzzzzzzzzzzzzzzzzzzzzzzzzzV"),
        (None, Some("zzzzzzzzzzzzzzzzzzzzzzzzzzz"), "zzzzzzzzzzzzzzzzzzzzzzzzzzy"),
        (Some("A00000000000000000000000001"), None, "A00000000000000000000000002"),
        (None, Some("A00000000000000000000000001"), "A00000000000000000000000000"),
        (Some("A0000000000000000000000000V"), None, "A0000000000000000000000000W"),
        (None, Some("A0000000000000000000000000V"), "A0000000000000000000000000U"),
        (Some("A00000000000000000000000000z"), None, "A00000000000000000000000001"),
        (None, Some("A00000000000000000000000000z"), "A00000000000000000000000000V"),
        (Some("a0"), Some("b00"), "a1"),
        (Some("az"), Some("b00"), "azV"),
        (Some("az"), Some("b01"), "b00"),
        (Some("Zz"), Some("a0"), "ZzV"),
        (Some("Zz"), Some("a1"), "a0"),
        (Some("a0"), Some("a2"), "a1"),
        (Some("a0"), Some("a1V"), "a1"),
        (Some("a0V"), Some("a1"), "a0l"),
        (Some("a1"), Some("a1V"), "a1G"),
        (Some("zz"), Some("zzz"), "a0"),
        (Some("b0"), Some("b1"), "a0"),
        (Some("Y00"), Some("Zz"), "Y01"),
        (Some(""), None, "a0"),
        (None, Some(""), "a0"),
        (Some(""), Some("a5"), "a4"),
        (Some("a5"), Some(""), "a6"),
        (Some("a"), None, "a0"),
        (None, Some("a"), "a0"),
        (Some("a"), Some("a5"), "a4"),
        (Some("a5"), Some("a"), "a6"),
        (Some("A"), None, "a0"),
        (None, Some("A"), "a0"),
        (Some("A"), Some("a5"), "a4"),
        (Some("a5"), Some("A"), "a6"),
        (Some("!"), None, "a0"),
        (None, Some("!"), "a0"),
        (Some("!"), Some("a5"), "a4"),
        (Some("a5"), Some("!"), "a6"),
        (Some("a0 "), None, "a0"),
        (None, Some("a0 "), "a0"),
        (Some("a0 "), Some("a5"), "a4"),
        (Some("a5"), Some("a0 "), "a6"),
        (Some("a00"), None, "a0"),
        (None, Some("a00"), "a0"),
        (Some("a00"), Some("a5"), "a4"),
        (Some("a5"), Some("a00"), "a6"),
        (Some("a10"), None, "a0"),
        (None, Some("a10"), "a0"),
        (Some("a10"), Some("a5"), "a4"),
        (Some("a5"), Some("a10"), "a6"),
        (Some("0"), None, "a0"),
        (None, Some("0"), "a0"),
        (Some("0"), Some("a5"), "a4"),
        (Some("a5"), Some("0"), "a6"),
        (Some("\u{e9}"), None, "a0"),
        (None, Some("\u{e9}"), "a0"),
        (Some("\u{e9}"), Some("a5"), "a4"),
        (Some("a5"), Some("\u{e9}"), "a6"),
        (Some("a0\u{e9}"), None, "a0"),
        (None, Some("a0\u{e9}"), "a0"),
        (Some("a0\u{e9}"), Some("a5"), "a4"),
        (Some("a5"), Some("a0\u{e9}"), "a6"),
        (Some("b0"), None, "a0"),
        (None, Some("b0"), "a0"),
        (Some("b0"), Some("a5"), "a4"),
        (Some("a5"), Some("b0"), "a6"),
        (Some("A00000000000000000000000000"), None, "a0"),
        (None, Some("A00000000000000000000000000"), "a0"),
        (Some("A00000000000000000000000000"), Some("a5"), "a4"),
        (Some("a5"), Some("A00000000000000000000000000"), "a6"),
        (Some("a1-"), None, "a0"),
        (None, Some("a1-"), "a0"),
        (Some("a1-"), Some("a5"), "a4"),
        (Some("a5"), Some("a1-"), "a6"),
        (Some("1"), None, "a0"),
        (None, Some("1"), "a0"),
        (Some("1"), Some("a5"), "a4"),
        (Some("a5"), Some("1"), "a6"),
        (Some("\u{1f600}"), None, "a0"),
        (None, Some("\u{1f600}"), "a0"),
        (Some("\u{1f600}"), Some("a5"), "a4"),
        (Some("a5"), Some("\u{1f600}"), "a6"),
        (Some("a5"), Some("a5"), "a6"),
        (Some("a9"), Some("a5"), "aA"),
        (Some("b00"), Some("a0"), "b01"),
        (Some("a5V"), Some("a5"), "a6"),
        (Some("zz"), Some("a0"), "Zz"),
        (Some("a0"), Some(""), "a1"),
        (Some(""), Some(""), "a0"),
        (Some(""), Some("a0"), "Zz"),
        (Some("Z1Ju"), Some("ZB4s"), "Z2"),
        (Some("Z8Q4E"), Some("bYVY"), "Z9"),
        (Some("biq383"), Some("YeN"), "bir"),
        (Some("bJ4"), Some("Y6ks"), "bJ5"),
        (Some("Z22Kh"), Some("ao"), "Z3"),
        (Some("ZFYrV"), Some("aCT8"), "ZG"),
        (Some("ZiSNp"), Some("Zk"), "Zj"),
        (Some("bgL"), Some("ZHb"), "bgM"),
        (Some("ZtDnw"), Some("Zqu"), "Zu"),
        (Some("aJ"), Some("ZntJN"), "aK"),
        (Some("Y9EW"), Some("bVSES"), "Y9F"),
        (Some("bZlF"), Some("ZyHtj"), "bZm"),
        (Some("bL1q"), Some("ZPb"), "bL2"),
        (Some("YIKpz"), Some("YweRjT"), "YIL"),
        (Some("YNrXp4"), Some("YIk5ms"), "YNs"),
        (Some("a8Eu8"), Some("YlDo3"), "a9"),
        (Some("Z1m"), Some("Zl9"), "Z2"),
        (Some("YflCSw"), Some("bEJxyb"), "Yfm"),
        (Some("ZN8TF"), Some("buu3"), "ZO"),
        (Some("YK3zZI"), Some("anjMB"), "YK4"),
        (Some("Zyo"), Some("bKAj"), "Zz"),
        (Some("Ye9"), Some("a7Hga"), "YeA"),
        (Some("Zsek"), Some("bJPV"), "Zt"),
        (Some("Z5kq"), Some("YEt5"), "Z6"),
        (Some("YrGT3"), Some("bKSVz"), "YrH"),
        (Some("bN9E2"), Some("aWdv"), "bNA"),
        (Some("ZEl"), Some("bzzxVR"), "ZF"),
        (Some("bJnAE"), Some("a2m38"), "bJo"),
        (Some("akO7d"), Some("bOq"), "al"),
        (Some("Yur7"), Some("YkWT"), "Yus"),
    ];

    #[rustfmt::skip]
    const KEYS_BETWEEN_CASES: &[(Option<&str>, Option<&str>, usize, &[&str])] = &[
        (None, None, 1, &["a0"]),
        (None, None, 2, &["a0", "a1"]),
        (None, None, 3, &["a0", "a1", "a2"]),
        (None, None, 4, &["a0", "a1", "a2", "a3"]),
        (None, None, 5, &["a0", "a1", "a2", "a3", "a4"]),
        (None, None, 6, &["a0", "a1", "a2", "a3", "a4", "a5"]),
        (None, None, 7, &["a0", "a1", "a2", "a3", "a4", "a5", "a6"]),
        (None, None, 8, &["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7"]),
        (None, None, 9, &["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"]),
        (None, None, 10, &["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9"]),
        (None, None, 11, &["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "aA"]),
        (None, None, 12, &["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "aA", "aB"]),
        (None, None, 13, &["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "aA", "aB", "aC"]),
        (None, None, 14, &["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "aA", "aB", "aC", "aD"]),
        (None, None, 15, &["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "aA", "aB", "aC", "aD", "aE"]),
        (None, None, 16, &["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "aA", "aB", "aC", "aD", "aE", "aF"]),
        (None, None, 17, &["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "aA", "aB", "aC", "aD", "aE", "aF", "aG"]),
        (None, None, 18, &["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "aA", "aB", "aC", "aD", "aE", "aF", "aG", "aH"]),
        (None, None, 19, &["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "aA", "aB", "aC", "aD", "aE", "aF", "aG", "aH", "aI"]),
        (None, None, 20, &["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "aA", "aB", "aC", "aD", "aE", "aF", "aG", "aH", "aI", "aJ"]),
        (Some("a0"), None, 1, &["a1"]),
        (Some("a0"), None, 2, &["a1", "a2"]),
        (Some("a0"), None, 3, &["a1", "a2", "a3"]),
        (Some("a0"), None, 4, &["a1", "a2", "a3", "a4"]),
        (Some("a0"), None, 5, &["a1", "a2", "a3", "a4", "a5"]),
        (Some("a0"), None, 6, &["a1", "a2", "a3", "a4", "a5", "a6"]),
        (Some("a0"), None, 7, &["a1", "a2", "a3", "a4", "a5", "a6", "a7"]),
        (Some("a0"), None, 8, &["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"]),
        (Some("a0"), None, 9, &["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9"]),
        (Some("a0"), None, 10, &["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "aA"]),
        (Some("a0"), None, 11, &["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "aA", "aB"]),
        (Some("a0"), None, 12, &["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "aA", "aB", "aC"]),
        (Some("a0"), None, 13, &["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "aA", "aB", "aC", "aD"]),
        (Some("a0"), None, 14, &["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "aA", "aB", "aC", "aD", "aE"]),
        (Some("a0"), None, 15, &["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "aA", "aB", "aC", "aD", "aE", "aF"]),
        (Some("a0"), None, 16, &["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "aA", "aB", "aC", "aD", "aE", "aF", "aG"]),
        (Some("a0"), None, 17, &["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "aA", "aB", "aC", "aD", "aE", "aF", "aG", "aH"]),
        (Some("a0"), None, 18, &["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "aA", "aB", "aC", "aD", "aE", "aF", "aG", "aH", "aI"]),
        (Some("a0"), None, 19, &["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "aA", "aB", "aC", "aD", "aE", "aF", "aG", "aH", "aI", "aJ"]),
        (Some("a0"), None, 20, &["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "aA", "aB", "aC", "aD", "aE", "aF", "aG", "aH", "aI", "aJ", "aK"]),
        (None, Some("a0"), 1, &["Zz"]),
        (None, Some("a0"), 2, &["Zz", "ZzV"]),
        (None, Some("a0"), 3, &["Zy", "Zz", "ZzV"]),
        (None, Some("a0"), 4, &["Zy", "Zz", "ZzV", "Zzl"]),
        (None, Some("a0"), 5, &["Zy", "ZyV", "Zz", "ZzV", "Zzl"]),
        (None, Some("a0"), 6, &["Zy", "ZyV", "Zz", "ZzG", "ZzV", "Zzl"]),
        (None, Some("a0"), 7, &["Zx", "Zy", "ZyV", "Zz", "ZzG", "ZzV", "Zzl"]),
        (None, Some("a0"), 8, &["Zx", "Zy", "ZyV", "Zz", "ZzG", "ZzV", "Zzl", "Zzt"]),
        (None, Some("a0"), 9, &["Zx", "Zy", "ZyV", "Zyl", "Zz", "ZzG", "ZzV", "Zzl", "Zzt"]),
        (None, Some("a0"), 10, &["Zx", "Zy", "ZyV", "Zyl", "Zz", "ZzG", "ZzO", "ZzV", "Zzl", "Zzt"]),
        (None, Some("a0"), 11, &["Zx", "ZxV", "Zy", "ZyV", "Zyl", "Zz", "ZzG", "ZzO", "ZzV", "Zzl", "Zzt"]),
        (None, Some("a0"), 12, &["Zx", "ZxV", "Zy", "ZyV", "Zyl", "Zz", "ZzG", "ZzO", "ZzV", "Zzd", "Zzl", "Zzt"]),
        (None, Some("a0"), 13, &["Zx", "ZxV", "Zy", "ZyG", "ZyV", "Zyl", "Zz", "ZzG", "ZzO", "ZzV", "Zzd", "Zzl", "Zzt"]),
        (None, Some("a0"), 14, &["Zx", "ZxV", "Zy", "ZyG", "ZyV", "Zyl", "Zz", "Zz8", "ZzG", "ZzO", "ZzV", "Zzd", "Zzl", "Zzt"]),
        (None, Some("a0"), 15, &["Zw", "Zx", "ZxV", "Zy", "ZyG", "ZyV", "Zyl", "Zz", "Zz8", "ZzG", "ZzO", "ZzV", "Zzd", "Zzl", "Zzt"]),
        (None, Some("a0"), 16, &["Zw", "Zx", "ZxV", "Zy", "ZyG", "ZyV", "Zyl", "Zz", "Zz8", "ZzG", "ZzO", "ZzV", "Zzd", "Zzl", "Zzt", "Zzx"]),
        (None, Some("a0"), 17, &["Zw", "Zx", "ZxV", "Zy", "ZyG", "ZyV", "Zyl", "Zyt", "Zz", "Zz8", "ZzG", "ZzO", "ZzV", "Zzd", "Zzl", "Zzt", "Zzx"]),
        (None, Some("a0"), 18, &["Zw", "Zx", "ZxV", "Zy", "ZyG", "ZyV", "Zyl", "Zyt", "Zz", "Zz8", "ZzG", "ZzO", "ZzS", "ZzV", "Zzd", "Zzl", "Zzt", "Zzx"]),
        (None, Some("a0"), 19, &["Zw", "Zx", "ZxV", "Zxl", "Zy", "ZyG", "ZyV", "Zyl", "Zyt", "Zz", "Zz8", "ZzG", "ZzO", "ZzS", "ZzV", "Zzd", "Zzl", "Zzt", "Zzx"]),
        (None, Some("a0"), 20, &["Zw", "Zx", "ZxV", "Zxl", "Zy", "ZyG", "ZyV", "Zyl", "Zyt", "Zz", "Zz8", "ZzG", "ZzO", "ZzS", "ZzV", "Zzd", "Zzh", "Zzl", "Zzt", "Zzx"]),
        (Some("a0"), Some("a1"), 1, &["a0V"]),
        (Some("a0"), Some("a1"), 2, &["a0V", "a0l"]),
        (Some("a0"), Some("a1"), 3, &["a0G", "a0V", "a0l"]),
        (Some("a0"), Some("a1"), 4, &["a0G", "a0V", "a0l", "a0t"]),
        (Some("a0"), Some("a1"), 5, &["a0G", "a0O", "a0V", "a0l", "a0t"]),
        (Some("a0"), Some("a1"), 6, &["a0G", "a0O", "a0V", "a0d", "a0l", "a0t"]),
        (Some("a0"), Some("a1"), 7, &["a08", "a0G", "a0O", "a0V", "a0d", "a0l", "a0t"]),
        (Some("a0"), Some("a1"), 8, &["a08", "a0G", "a0O", "a0V", "a0d", "a0l", "a0t", "a0x"]),
        (Some("a0"), Some("a1"), 9, &["a08", "a0G", "a0O", "a0S", "a0V", "a0d", "a0l", "a0t", "a0x"]),
        (Some("a0"), Some("a1"), 10, &["a08", "a0G", "a0O", "a0S", "a0V", "a0d", "a0h", "a0l", "a0t", "a0x"]),
        (Some("a0"), Some("a1"), 11, &["a08", "a0C", "a0G", "a0O", "a0S", "a0V", "a0d", "a0h", "a0l", "a0t", "a0x"]),
        (Some("a0"), Some("a1"), 12, &["a08", "a0C", "a0G", "a0O", "a0S", "a0V", "a0d", "a0h", "a0l", "a0p", "a0t", "a0x"]),
        (Some("a0"), Some("a1"), 13, &["a08", "a0C", "a0G", "a0K", "a0O", "a0S", "a0V", "a0d", "a0h", "a0l", "a0p", "a0t", "a0x"]),
        (Some("a0"), Some("a1"), 14, &["a08", "a0C", "a0G", "a0K", "a0O", "a0S", "a0V", "a0Z", "a0d", "a0h", "a0l", "a0p", "a0t", "a0x"]),
        (Some("a0"), Some("a1"), 15, &["a04", "a08", "a0C", "a0G", "a0K", "a0O", "a0S", "a0V", "a0Z", "a0d", "a0h", "a0l", "a0p", "a0t", "a0x"]),
        (Some("a0"), Some("a1"), 16, &["a04", "a08", "a0C", "a0G", "a0K", "a0O", "a0S", "a0V", "a0Z", "a0d", "a0h", "a0l", "a0p", "a0t", "a0x", "a0z"]),
        (Some("a0"), Some("a1"), 17, &["a04", "a08", "a0C", "a0G", "a0K", "a0O", "a0S", "a0U", "a0V", "a0Z", "a0d", "a0h", "a0l", "a0p", "a0t", "a0x", "a0z"]),
        (Some("a0"), Some("a1"), 18, &["a04", "a08", "a0C", "a0G", "a0K", "a0O", "a0S", "a0U", "a0V", "a0Z", "a0d", "a0h", "a0j", "a0l", "a0p", "a0t", "a0x", "a0z"]),
        (Some("a0"), Some("a1"), 19, &["a04", "a08", "a0C", "a0E", "a0G", "a0K", "a0O", "a0S", "a0U", "a0V", "a0Z", "a0d", "a0h", "a0j", "a0l", "a0p", "a0t", "a0x", "a0z"]),
        (Some("a0"), Some("a1"), 20, &["a04", "a08", "a0C", "a0E", "a0G", "a0K", "a0O", "a0S", "a0U", "a0V", "a0Z", "a0d", "a0h", "a0j", "a0l", "a0p", "a0r", "a0t", "a0x", "a0z"]),
        (Some("a0"), Some("a5"), 1, &["a1"]),
        (Some("a0"), Some("a5"), 4, &["a0V", "a1", "a2", "a3"]),
        (Some("a0"), Some("a5"), 7, &["a0G", "a0V", "a0l", "a1", "a1V", "a2", "a3"]),
        (Some("a0"), Some("a5"), 10, &["a0G", "a0V", "a0l", "a0t", "a1", "a1V", "a1l", "a2", "a3", "a4"]),
        (Some("a0"), Some("a5"), 13, &["a0G", "a0O", "a0V", "a0d", "a0l", "a0t", "a1", "a1V", "a1l", "a2", "a2V", "a3", "a4"]),
        (Some("a0"), Some("a5"), 16, &["a08", "a0G", "a0O", "a0V", "a0d", "a0l", "a0t", "a1", "a1G", "a1V", "a1l", "a2", "a2V", "a3", "a4", "a4V"]),
        (Some("a0"), Some("a5"), 19, &["a08", "a0G", "a0O", "a0S", "a0V", "a0d", "a0l", "a0t", "a0x", "a1", "a1G", "a1V", "a1l", "a1t", "a2", "a2V", "a3", "a4", "a4V"]),
        (Some("az"), Some("b01"), 1, &["b00"]),
        (Some("az"), Some("b01"), 4, &["azV", "b00", "b00V", "b00l"]),
        (Some("az"), Some("b01"), 7, &["azG", "azV", "azl", "b00", "b00G", "b00V", "b00l"]),
        (Some("az"), Some("b01"), 10, &["azG", "azV", "azl", "azt", "b00", "b00G", "b00O", "b00V", "b00l", "b00t"]),
        (Some("az"), Some("b01"), 13, &["azG", "azO", "azV", "azd", "azl", "azt", "b00", "b00G", "b00O", "b00V", "b00d", "b00l", "b00t"]),
        (Some("az"), Some("b01"), 16, &["az8", "azG", "azO", "azV", "azd", "azl", "azt", "b00", "b008", "b00G", "b00O", "b00V", "b00d", "b00l", "b00t", "b00x"]),
        (Some("az"), Some("b01"), 19, &["az8", "azG", "azO", "azS", "azV", "azd", "azl", "azt", "azx", "b00", "b008", "b00G", "b00O", "b00S", "b00V", "b00d", "b00l", "b00t", "b00x"]),
        (Some("Zy"), Some("a1"), 1, &["Zz"]),
        (Some("Zy"), Some("a1"), 4, &["ZyV", "Zz", "a0", "a0V"]),
        (Some("Zy"), Some("a1"), 7, &["ZyG", "ZyV", "Zyl", "Zz", "ZzV", "a0", "a0V"]),
        (Some("Zy"), Some("a1"), 10, &["ZyG", "ZyV", "Zyl", "Zyt", "Zz", "ZzV", "Zzl", "a0", "a0V", "a0l"]),
        (Some("Zy"), Some("a1"), 13, &["ZyG", "ZyO", "ZyV", "Zyd", "Zyl", "Zyt", "Zz", "ZzV", "Zzl", "a0", "a0G", "a0V", "a0l"]),
        (Some("Zy"), Some("a1"), 16, &["Zy8", "ZyG", "ZyO", "ZyV", "Zyd", "Zyl", "Zyt", "Zz", "ZzG", "ZzV", "Zzl", "a0", "a0G", "a0V", "a0l", "a0t"]),
        (Some("Zy"), Some("a1"), 19, &["Zy8", "ZyG", "ZyO", "ZyS", "ZyV", "Zyd", "Zyl", "Zyt", "Zyx", "Zz", "ZzG", "ZzV", "Zzl", "Zzt", "a0", "a0G", "a0V", "a0l", "a0t"]),
        (Some("a0"), Some("a1"), 0, &[]),
        (Some("a0"), Some("a1"), 100, &["a01", "a01V", "a02", "a03", "a03V", "a04", "a05", "a05V", "a06", "a07", "a07V", "a08", "a09", "a09V", "a0A", "a0B", "a0BV", "a0C", "a0D", "a0DV", "a0E", "a0EV", "a0F", "a0FV", "a0G", "a0H", "a0HV", "a0I", "a0J", "a0JV", "a0K", "a0L", "a0LV", "a0M", "a0N", "a0NV", "a0O", "a0P", "a0PV", "a0Q", "a0R", "a0RV", "a0S", "a0T", "a0TV", "a0U", "a0UG", "a0UV", "a0Ul", "a0V", "a0W", "a0WV", "a0X", "a0Y", "a0YV", "a0Z", "a0a", "a0aV", "a0b", "a0c", "a0cV", "a0d", "a0e", "a0eV", "a0f", "a0g", "a0gV", "a0h", "a0i", "a0iV", "a0j", "a0jV", "a0k", "a0kV", "a0l", "a0m", "a0mV", "a0n", "a0o", "a0oV", "a0p", "a0q", "a0qV", "a0r", "a0rV", "a0s", "a0sV", "a0t", "a0u", "a0uV", "a0v", "a0w", "a0wV", "a0x", "a0y", "a0yV", "a0z", "a0zG", "a0zV", "a0zl"]),
        (Some("a5"), Some("a5"), 4, &["a5V", "a6", "a7", "a8"]),
        (Some("a9"), Some("a5"), 4, &["a9V", "aA", "aB", "aC"]),
        (Some(""), Some("a5"), 4, &["a3", "a4", "a4V", "a4l"]),
        (Some("a5"), Some(""), 4, &["a5V", "a6", "a7", "a8"]),
        (Some("!"), Some("!!"), 5, &["Zz", "ZzV", "a0", "a1", "a2"]),
        (Some("a5"), None, 3, &["a6", "a7", "a8"]),
        (Some("b0"), Some("a0"), 6, &["Zy", "ZyV", "Zz", "ZzG", "ZzV", "Zzl"]),
    ];

    #[rustfmt::skip]
    const VALID_KEY_CASES: &[(&str, bool)] = &[
        ("a0", true),
        ("a1", true),
        ("az", true),
        ("b00", true),
        ("b0V", true),
        ("Zz", true),
        ("Y00", true),
        ("a0V", true),
        ("a1V5", true),
        ("zzzzzzzzzzzzzzzzzzzzzzzzzzz", true),
        ("A00000000000000000000000001", true),
        ("A0000000000000000000000000V", true),
        ("", false),
        ("a", false),
        ("A", false),
        ("a00", false),
        ("a10", false),
        ("a1_", false),
        ("a 1", false),
        ("0", false),
        ("!", false),
        ("\u{e9}", false),
        ("a0\u{e9}", false),
        ("A00000000000000000000000000", false),
        ("b0", false),
        ("Y0", false),
        ("Z", false),
        ("Zz0", false),
        ("\u{1f600}", false),
        ("a0\u{a}", false),
        ("Aa", false),
        ("aa", true),
        ("c0", false),
        ("c000", true),
    ];

    #[test]
    fn valid_key_matches_the_typescript() {
        for &(key, want) in VALID_KEY_CASES {
            assert_eq!(valid_key(key), want, "valid_key({key:?})");
        }
    }

    #[test]
    fn key_between_matches_the_typescript() {
        for &(a, b, want) in KEY_BETWEEN_CASES {
            assert_eq!(key_between(a, b), want, "key_between({a:?}, {b:?})");
        }
    }

    #[test]
    fn keys_between_matches_the_typescript() {
        for &(a, b, n, want) in KEYS_BETWEEN_CASES {
            assert_eq!(keys_between(a, b, n), want, "keys_between({a:?}, {b:?}, {n})");
        }
    }

    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }

        fn below(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }
    }

    fn assert_strictly_increasing(keys: &[String]) {
        for pair in keys.windows(2) {
            assert!(pair[0] < pair[1], "{} should sort before {}", pair[0], pair[1]);
        }
    }

    #[test]
    fn random_insertions_stay_sorted_and_valid() {
        let mut rng = Rng(0x2545_f491_4f6c_dd1d);
        let mut list: Vec<String> = Vec::new();
        for _ in 0..5000 {
            let at = rng.below(list.len() + 1);
            let a = at.checked_sub(1).map(|i| list[i].as_str());
            let b = list.get(at).map(String::as_str);
            let key = key_between(a, b);
            assert!(valid_key(&key), "{key} should be valid");
            list.insert(at, key);
        }
        assert_strictly_increasing(&list);
        assert!(list.iter().all(|k| valid_key(k)));
    }

    #[test]
    fn many_keys_between_two_are_sorted_and_valid() {
        let keys = keys_between(Some("a0"), Some("a1"), 500);
        assert_eq!(keys.len(), 500);
        assert!(keys.iter().all(|k| valid_key(k)));
        assert_strictly_increasing(&keys);
        assert!(keys[0].as_str() > "a0" && keys[499].as_str() < "a1");
    }

    #[test]
    fn garbage_never_panics() {
        let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
        let alphabet: Vec<char> = "0123456789AYZaybz!é😀 ".chars().collect();
        let random_key = |rng: &mut Rng| -> Option<String> {
            if rng.below(5) == 0 {
                return None;
            }
            let len = rng.below(8);
            Some((0..len).map(|_| alphabet[rng.below(alphabet.len())]).collect())
        };
        for _ in 0..5000 {
            let (a, b) = (random_key(&mut rng), random_key(&mut rng));
            let key = key_between(a.as_deref(), b.as_deref());
            assert!(valid_key(&key), "{key:?} from {a:?}, {b:?}");
            let n = rng.below(6);
            assert_eq!(keys_between(a.as_deref(), b.as_deref(), n).len(), n);
        }
    }
}
