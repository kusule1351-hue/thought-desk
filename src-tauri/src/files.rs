//! Serves stored files to the webview through the `tdfile` scheme, and
//! removes stray files that neither the library nor any page knows about.

use crate::db::Db;
use crate::library::mime_for;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};
use tauri::http::{Request, Response, StatusCode};
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};

/// Whether `name` is safe to join onto the files folder: plain letters,
/// digits and dots, and nothing Windows treats specially (device names such
/// as `NUL` or `COM1.png`, a trailing dot or space) or the app uses for
/// half-written files (`.part`). Every caller goes through this one check.
pub fn is_valid_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("");
    !name.is_empty()
        && name.len() <= 64
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '.')
        && !name.starts_with('.')
        && !name.ends_with(['.', ' '])
        && !name.to_ascii_lowercase().ends_with(".part")
        && !is_device(stem)
}

/// `CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9` and `LPT1`-`LPT9`, in any case.
fn is_device(stem: &str) -> bool {
    let up = stem.to_ascii_uppercase();
    matches!(up.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|p| up.strip_prefix(p).is_some_and(|n| matches!(n.as_bytes(), [b'1'..=b'9'])))
}

/// Whether `name` has the shape of a file the app stored itself: 32 hex
/// digits, a dot and an extension (`library.rs` makes these; images saved
/// before the library existed look the same). Only these are ever deleted.
pub fn is_app_name(name: &str) -> bool {
    is_valid_name(name)
        && name.split_once('.').is_some_and(|(stem, ext)| {
            stem.len() == 32
                && stem.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                && !ext.is_empty()
                && ext.bytes().all(|b| b.is_ascii_alphanumeric())
        })
}

pub fn protocol<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let dir: PathBuf = ctx.app_handle().state::<Db>().files_dir.clone();
    let name = request.uri().path().trim_start_matches('/').to_string();
    let range = request.headers().get("range").and_then(|v| v.to_str().ok()).and_then(parse_range);
    // File reads happen off the main thread (on a reused worker) so big
    // images never stall the UI.
    tauri::async_runtime::spawn_blocking(move || {
        let response = if is_valid_name(&name) {
            serve(&dir.join(&name), &name, range)
        } else {
            None
        };
        let response = response.unwrap_or_else(not_found);
        if let Ok(r) = response {
            responder.respond(r);
        }
    });
}

fn not_found() -> tauri::http::Result<Response<Vec<u8>>> {
    Response::builder().status(StatusCode::NOT_FOUND).header("Content-Security-Policy", csp_for("")).body(Vec::new())
}

/// What a response may do if the webview shows it as a page (in an iframe,
/// say): nothing but display itself. No script or plugins, whatever the
/// bytes are (an SVG, or a file that isn't what its name says). `sandbox`
/// also gives it an empty origin, so it can't reach the app; it's left off
/// PDFs, which Chromium's viewer may refuse to open when sandboxed.
fn csp_for(mime: &str) -> &'static str {
    match mime {
        "application/pdf" => "default-src 'none'; style-src 'unsafe-inline'",
        m if m.starts_with("audio/") || m.starts_with("video/") => {
            "default-src 'none'; media-src 'self'; style-src 'unsafe-inline'; sandbox"
        }
        _ => "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    }
}

/// Largest slice sent for one range request. Audio, video and PDFs ask for
/// ranges, so a long recording streams in pieces instead of being read into
/// memory whole.
const CHUNK: u64 = 4 << 20;

/// `bytes=START-[END]` (the only form media players and PDF viewers send).
fn parse_range(header: &str) -> Option<(u64, Option<u64>)> {
    let (start, end) = header.strip_prefix("bytes=")?.split_once('-')?;
    let start = start.trim().parse().ok()?;
    let end = match end.trim() {
        "" => None,
        e => Some(e.parse().ok()?),
    };
    Some((start, end))
}

fn serve(path: &std::path::Path, name: &str, range: Option<(u64, Option<u64>)>) -> Option<tauri::http::Result<Response<Vec<u8>>>> {
    use std::io::{Read, Seek, SeekFrom};
    let mime = mime_for(name);
    // Documents can be edited in another app, so revalidate those; images
    // are never rewritten in place.
    let cache = if mime.starts_with("image/") { "max-age=31536000, immutable" } else { "no-cache" };
    let builder = Response::builder()
        .header("Content-Type", mime)
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", csp_for(mime))
        // The app reads text files with fetch() for previews, and the app's
        // origin differs from this scheme's.
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", cache)
        .header("Accept-Ranges", "bytes");
    let Some((start, end)) = range else {
        return Some(builder.status(StatusCode::OK).body(std::fs::read(path).ok()?));
    };
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    // A range that ends before it starts can't be served (and would underflow below).
    if start >= len || end.is_some_and(|e| e < start) {
        return Some(
            builder
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header("Content-Range", format!("bytes */{len}"))
                .body(Vec::new()),
        );
    }
    let end = end.unwrap_or(u64::MAX).min(len - 1).min(start + CHUNK - 1);
    let mut bytes = vec![0; (end - start + 1) as usize];
    file.seek(SeekFrom::Start(start)).ok()?;
    file.read_exact(&mut bytes).ok()?;
    Some(
        builder
            .status(StatusCode::PARTIAL_CONTENT)
            .header("Content-Range", format!("bytes {start}-{end}/{len}"))
            .body(bytes),
    )
}

/// Deletes stored files that the library doesn't list and no page refers to
/// (left over from a failed save, say). Files younger than a day are kept.
pub fn collect_garbage(db: &Db) {
    let Ok(known) = db.known_files() else { return };
    let Ok(entries) = std::fs::read_dir(&db.files_dir) else { return };
    let cutoff = SystemTime::now() - Duration::from_secs(24 * 60 * 60);
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        // Anything not shaped like a name the app makes isn't ours to delete
        // (the folder may be one the user chose, with their own files in it).
        if known.contains(&name) || !is_app_name(&name) {
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|t| t < cutoff)
            .unwrap_or(false);
        // Checked last and one file at a time: strays are rare, and this
        // reads page bodies.
        if old && matches!(db.content_mentions(&name), Ok(false)) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    const HEX: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn refuses_windows_device_and_unsafe_names() {
        for ok in ["a.png", "abc123.png", &format!("{HEX}.pdf"), "COM10.png", "console.txt", "nul2", "LPT0.txt", "a.partial"] {
            assert!(is_valid_name(ok), "{ok}");
        }
        for bad in [
            "", ".hidden", "a/b", "a b", "../x", "CON", "con.txt", "Prn", "AUX.png", "NUL", "nul.tar.gz", "COM1.png", "com9",
            "LPT1", "lpt9.txt", "name.", "name..", "a.part", "a.PART", &"x".repeat(65),
        ] {
            assert!(!is_valid_name(bad), "{bad}");
        }
        assert!(!is_valid_name("name "), "a trailing space");
    }

    #[test]
    fn recognises_names_the_app_makes() {
        for ok in [format!("{HEX}.png"), format!("{HEX}.bin"), format!("{HEX}.JPG")] {
            assert!(is_app_name(&ok), "{ok}");
        }
        for other in ["holiday.jpg", "abc123.png", HEX, &format!("{HEX}."), &format!("{HEX}.tar.gz"), &format!("{}.png", &HEX[1..]), &format!("{}.png", HEX.to_uppercase())] {
            assert!(!is_app_name(other), "{other}");
        }
    }

    #[test]
    fn garbage_collection_only_deletes_files_the_app_made() {
        let dir = std::env::temp_dir().join(format!("td-gc-{}", uuid::Uuid::new_v4().simple()));
        let db = Db::open(&dir).unwrap();
        let old = SystemTime::now() - Duration::from_secs(3 * 24 * 60 * 60);
        let put = |name: &str| {
            let path = db.files_dir.join(name);
            std::fs::write(&path, b"x").unwrap();
            std::fs::File::options().write(true).open(&path).unwrap().set_modified(old).unwrap();
            path
        };
        let stray = put(&format!("{HEX}.png"));
        let strangers = [put("holiday.jpg"), put("thesis.docx"), put("abc123.png")];
        let kept = db.import_file(b"mine", "mine.txt", "").unwrap();
        std::fs::File::options().write(true).open(db.files_dir.join(&kept.stored)).unwrap().set_modified(old).unwrap();

        collect_garbage(&db);
        assert!(!stray.exists(), "an old stray the app made goes");
        assert!(strangers.iter().all(|p| p.exists()), "other people's files stay");
        assert!(db.files_dir.join(&kept.stored).exists(), "listed files stay");
    }

    fn csp_of(name: &str, range: Option<(u64, Option<u64>)>) -> String {
        let dir = std::env::temp_dir().join(format!("td-csp-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(name), b"<svg onload=alert(1)>").unwrap();
        let r = serve(&dir.join(name), name, range).unwrap().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        r.headers()["content-security-policy"].to_str().unwrap().to_string()
    }

    #[test]
    fn every_response_carries_a_policy_that_forbids_script() {
        for name in ["a.png", "a.svg", "a.txt", "a.html", "a.xyz", "a.mp3", "a.mp4"] {
            let csp = csp_of(name, None);
            assert!(csp.starts_with("default-src 'none'"), "{name}: {csp}");
            assert!(!csp.contains("script-src") && !csp.contains("unsafe-eval"), "{name}: {csp}");
            assert!(csp.contains("sandbox"), "{name}: {csp}");
        }
        assert!(csp_of("a.mp4", None).contains("media-src 'self'"));
        let pdf = csp_of("a.pdf", None);
        assert!(pdf.starts_with("default-src 'none'") && !pdf.contains("sandbox"), "the PDF viewer needs no sandbox: {pdf}");
        // Ranges and misses carry it too.
        assert_eq!(csp_of("a.pdf", Some((0, None))), pdf);
        assert!(csp_of("a.svg", Some((0, None))).contains("sandbox"));
        assert!(not_found().unwrap().headers()["content-security-policy"].to_str().unwrap().contains("default-src 'none'"));
    }

    #[test]
    fn refuses_a_range_that_ends_before_it_starts() {
        let dir = TempDir::new("td-range-bad");
        let path = dir.join("clip.mp4");
        std::fs::write(&path, vec![7u8; 100]).unwrap();
        let response = serve(&path, "clip.mp4", parse_range("bytes=10-5")).unwrap().unwrap();
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
    }

    #[test]
    fn serves_ranges_in_chunks() {
        assert_eq!(parse_range("bytes=0-"), Some((0, None)));
        assert_eq!(parse_range("bytes=10-19"), Some((10, Some(19))));
        assert_eq!(parse_range("bytes=-5"), None, "suffix ranges fall back to the whole file");
        assert_eq!(parse_range("items=0-1"), None);

        let dir = TempDir::new("td-range");
        let path = dir.join("clip.mp4");
        let data: Vec<u8> = (0..(CHUNK + 100)).map(|i| (i % 251) as u8).collect();
        std::fs::write(&path, &data).unwrap();

        let r = serve(&path, "clip.mp4", Some((10, Some(19)))).unwrap().unwrap();
        assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(r.body(), &data[10..20]);
        assert_eq!(r.headers()["content-range"], format!("bytes 10-19/{}", data.len()));

        // An open-ended request gets one chunk, not the whole file.
        let r = serve(&path, "clip.mp4", Some((0, None))).unwrap().unwrap();
        assert_eq!(r.body().len() as u64, CHUNK);

        let r = serve(&path, "clip.mp4", Some((data.len() as u64, None))).unwrap().unwrap();
        assert_eq!(r.status(), StatusCode::RANGE_NOT_SATISFIABLE);

        let r = serve(&path, "clip.mp4", None).unwrap().unwrap();
        assert_eq!(r.body().len(), data.len());
        assert!(serve(&dir.join("missing.mp4"), "missing.mp4", None).is_none());
    }
}
