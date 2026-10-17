//! Serves stored files to the webview through the `tdfile` scheme, and
//! removes stray files that neither the library nor any page knows about.

use crate::db::Db;
use crate::library::mime_for;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};
use tauri::http::{Request, Response, StatusCode};
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};

pub fn is_valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '.')
        && !name.starts_with('.')
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
        let response = response.unwrap_or_else(|| Response::builder().status(StatusCode::NOT_FOUND).body(Vec::new()));
        if let Ok(r) = response {
            responder.respond(r);
        }
    });
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
        if known.contains(&name) {
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

    #[test]
    fn refuses_a_range_that_ends_before_it_starts() {
        let dir = std::env::temp_dir().join(format!("td-range-bad-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("clip.mp4");
        std::fs::write(&path, vec![7u8; 100]).unwrap();
        let response = serve(&path, "clip.mp4", parse_range("bytes=10-5")).unwrap().unwrap();
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn serves_ranges_in_chunks() {
        assert_eq!(parse_range("bytes=0-"), Some((0, None)));
        assert_eq!(parse_range("bytes=10-19"), Some((10, Some(19))));
        assert_eq!(parse_range("bytes=-5"), None, "suffix ranges fall back to the whole file");
        assert_eq!(parse_range("items=0-1"), None);

        let dir = std::env::temp_dir().join(format!("td-range-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
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
