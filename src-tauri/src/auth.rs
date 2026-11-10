//! Signing in with Google or GitHub from the desktop. The browser comes back
//! to a one-time listener on 127.0.0.1 (OAuth's loopback redirect for native
//! apps, RFC 8252), on a fixed port because Clerk sends people back only to
//! addresses on its allowlist. What comes back (a nonce that lets the app
//! take over the sign-in it started) is useless without the client token the
//! app keeps, so nothing else on this computer can use it. The page the
//! browser is left on links back to the app (`OPEN_LINK`).

use std::io::{ErrorKind, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// The port the browser comes back to: http://127.0.0.1:47823/auth/callback.
pub const PORT: u16 = 47823;
const PATH: &str = "/auth/callback";
/// Which listener is current: starting another sign-in retires the last one.
static CURRENT: AtomicU64 = AtomicU64::new(0);
/// How long a sign-in may take in the browser.
const WAIT: Duration = Duration::from_secs(600);
/// The query parameter that carries the per-sign-in secret, when the app
/// started the sign-in with one.
const STATE_KEY: &str = "td_state";
/// Clerk's codes for "new here: make the account", which aren't failures.
const TRANSFERS: [&str; 2] = ["external_account_not_found", "external_account_exists"];

/// Starts listening and returns the port. When the browser comes back, the
/// window is brought forward and `auth-callback` carries the query string
/// (`rotating_token_nonce=…`, or `__clerk_status=failed&__clerk_error_code=…`).
/// Requests that aren't a real return (any web page can send one to this
/// port) are answered with a 404 and otherwise ignored: the app keeps
/// waiting and the window stays where it is. With a `state`, the return must
/// also carry it as `td_state=…`.
pub fn listen(app: AppHandle, state: Option<String>) -> Result<u16, String> {
    let me = CURRENT.fetch_add(1, Ordering::SeqCst) + 1;
    let listener = bind(PORT)?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        let deadline = Instant::now() + WAIT;
        while Instant::now() < deadline && CURRENT.load(Ordering::SeqCst) == me {
            match listener.accept() {
                Ok((stream, _)) => {
                    if let Some(query) = answer(stream, state.as_deref()) {
                        let _ = app.emit("auth-callback", query);
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                        return;
                    }
                }
                Err(e) if e.kind() == ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(100)),
                Err(_) => return,
            }
        }
    });
    Ok(PORT)
}

/// Binds the port, waiting a moment for a sign-in started just before to let
/// go of it (its listener checks every tenth of a second).
fn bind(port: u16) -> Result<TcpListener, String> {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match TcpListener::bind(("127.0.0.1", port)) {
            Ok(listener) => return Ok(listener),
            Err(e) if e.kind() == ErrorKind::AddrInUse && Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Err(e) if e.kind() == ErrorKind::AddrInUse => {
                return Err(format!(
                    "Signing in with Google or GitHub needs port {port}, and another program is using it. Close it and try again, or sign in with an email code."
                ))
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

/// Answers one browser request. A real return from Clerk gets a page saying
/// how sign-in went, and its query string is returned; anything else (a
/// favicon, a stray page poking at the port, a request from another
/// computer) gets a 404 and returns None, so the sign-in stays pending.
fn answer(mut stream: TcpStream, state: Option<&str>) -> Option<String> {
    if !stream.peer_addr().is_ok_and(|a| is_local(&a)) {
        return None;
    }
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut buf = [0u8; 8192];
    let n = stream.read(&mut buf).ok()?;
    let request = String::from_utf8_lossy(&buf[..n]);
    let port = stream.local_addr().map(|a| a.port()).unwrap_or(PORT);
    let query = callback_query(&request)
        .filter(|query| host_is(&request, port) && is_return(query, state))
        .map(str::to_string);
    let reply = match &query {
        Some(query) => page(!query.is_empty() && !failed(query)),
        None => "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
    };
    let _ = stream.write_all(reply.as_bytes());
    // Let the browser hang up first, so the port isn't left waiting to close
    // (TIME_WAIT) and can be listened on again at once.
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.read(&mut buf);
    query
}

/// The query string of a `GET /auth/callback[?…]` request line ("" without one).
fn callback_query(request: &str) -> Option<&str> {
    let mut parts = request.lines().next()?.split_whitespace();
    if parts.next()? != "GET" {
        return None;
    }
    let target = parts.next()?;
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    (path == PATH).then_some(query)
}

/// Only this computer's own loopback address counts.
fn is_local(peer: &SocketAddr) -> bool {
    peer.ip() == std::net::Ipv4Addr::LOCALHOST
}

/// The browser asked for 127.0.0.1 on our port (a web page that tricked the
/// browser into another name for it asks for that name).
fn host_is(request: &str, port: u16) -> bool {
    let host = request.lines().skip(1).find_map(|l| l.split_once(':').filter(|(k, _)| k.eq_ignore_ascii_case("host")).map(|(_, v)| v.trim()));
    host == Some(&format!("127.0.0.1:{port}"))
}

/// Whether a callback's query is Clerk's return (a nonce, or its status
/// parameters for a failure) and, if the sign-in has a secret, carries it.
fn is_return(query: &str, state: Option<&str>) -> bool {
    let pairs: Vec<(&str, &str)> = query.split('&').filter_map(|p| p.split_once('=')).collect();
    let has = |key: &str| pairs.iter().any(|&(k, v)| k == key && !v.is_empty());
    (has("rotating_token_nonce") || has("__clerk_status"))
        && state.is_none_or(|s| pairs.iter().any(|&(k, v)| k == STATE_KEY && v == s))
}

/// Whether the sign-in came back failed (not merely "new here").
fn failed(query: &str) -> bool {
    let pairs: Vec<(&str, &str)> = query.split('&').filter_map(|p| p.split_once('=')).collect();
    let has = |key: &str, value: &str| pairs.iter().any(|&(k, v)| k == key && v == value);
    let transfer = pairs.iter().any(|&(k, v)| k == "__clerk_error_code" && TRANSFERS.contains(&v));
    pairs.iter().any(|&(k, _)| k == "error") || (has("__clerk_status", "failed") && !transfer)
}

/// The page's way back to the app, for when the system won't let the window
/// come forward by itself (Linux on Wayland, a browser someone is typing in):
/// a click on a link is something the system does hand the front over for.
/// The installers register the scheme (tauri.conf.json). The link is this
/// fixed text, and the app reads none of it: any website can open a
/// thoughtdesk:// link, and all one ever does is show the window (main.rs).
const OPEN_LINK: &str = "thoughtdesk://open";

/// The page the browser is left on. No scripts, and nothing from the request
/// is written into it.
fn page(ok: bool) -> String {
    let (title, text) = if ok {
        ("You're signed in", "You can close this tab and go back to Thought Desk.")
    } else {
        ("Sign-in didn't finish", "Go back to Thought Desk and try again.")
    };
    let body = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{title} · Thought Desk</title>\
         <meta name=\"viewport\" content=\"width=device-width\"><style>\
         body{{margin:0;height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;\
         background:#f6f6f7;color:#1d1d1f}}\
         main{{text-align:center;padding:24px}}h1{{font-size:22px;font-weight:600;margin:0 0 8px}}p{{margin:0;opacity:.7}}\
         a{{display:inline-block;margin-top:20px;padding:9px 18px;border-radius:8px;background:#1d1d1f;color:#f6f6f7;\
         font-size:14px;font-weight:500;text-decoration:none}}a:hover{{opacity:.85}}\
         a:focus-visible{{outline:2px solid #1d1d1f;outline-offset:2px}}\
         @media(prefers-color-scheme:dark){{body{{background:#0f0f10;color:#f5f5f7}}\
         a{{background:#f5f5f7;color:#0f0f10;outline-color:#f5f5f7}}}}\
         </style></head><body><main><h1>{title}</h1><p>{text}</p>\
         <a href=\"{OPEN_LINK}\">Open Thought Desk</a></main></body></html>"
    );
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_only_the_callback() {
        assert_eq!(callback_query("GET /auth/callback?rotating_token_nonce=abc HTTP/1.1\r\nHost: x\r\n"), Some("rotating_token_nonce=abc"));
        assert_eq!(callback_query("GET /auth/callback?__clerk_status=failed HTTP/1.1"), Some("__clerk_status=failed"));
        assert_eq!(callback_query("GET /auth/callback HTTP/1.1"), Some(""), "back with nothing: still the callback");
        for other in ["GET /favicon.ico HTTP/1.1", "GET /favicon.ico?x=1 HTTP/1.1", "POST /auth/callback?code=abc HTTP/1.1", ""] {
            assert_eq!(callback_query(other), None, "{other}");
        }
    }

    #[test]
    fn tells_a_failure_from_a_new_account() {
        assert!(!failed("rotating_token_nonce=abc"));
        assert!(failed("__clerk_status=failed&__clerk_error_code=oauth_access_denied"));
        assert!(failed("__clerk_status=failed"));
        assert!(failed("error=access_denied&error_description=No"));
        assert!(!failed("__clerk_status=failed&__clerk_error_code=external_account_not_found&rotating_token_nonce=abc"));
    }

    /// The browser's side of a sign-in coming back: it sends the request and
    /// reads the reply, then hangs up (as browsers do after "Connection:
    /// close") or, if `lingers`, waits for the app to.
    fn browse(port: u16, path: &str, lingers: bool) -> String {
        browse_host(port, path, &format!("127.0.0.1:{port}"), lingers)
    }

    fn browse_host(port: u16, path: &str, host: &str, lingers: bool) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.write_all(format!("GET {path} HTTP/1.1\r\nHost: {host}\r\n\r\n").as_bytes()).unwrap();
        let mut reply = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            let n = s.read(&mut buf).unwrap();
            reply.extend_from_slice(&buf[..n]);
            if n == 0 || (!lingers && reply.ends_with(b"</html>")) {
                return String::from_utf8(reply).unwrap();
            }
        }
    }

    /// One sign-in coming back to a listener on `port`; returns the page.
    fn sign_in(port: u16, query: &str, lingers: bool) -> String {
        let listener = bind(port).expect("the port is free");
        let port = listener.local_addr().unwrap().port();
        let path = format!("{PATH}?{query}");
        let browser = std::thread::spawn(move || browse(port, &path, lingers));
        let (stream, _) = listener.accept().unwrap();
        assert_eq!(answer(stream, None).as_deref(), Some(query));
        browser.join().unwrap()
    }

    #[test]
    fn answers_the_browser_and_lets_go_of_the_port() {
        let port = bind(0).unwrap().local_addr().unwrap().port();
        let reply = sign_in(port, "rotating_token_nonce=xyz", false);
        assert!(reply.starts_with("HTTP/1.1 200 OK"), "{reply}");
        assert!(reply.contains("You're signed in"));
        assert!(reply.contains(BUTTON), "{reply}");
        // The length the browser is told is the page's own, button and all.
        let (head, body) = reply.split_once("\r\n\r\n").unwrap();
        assert!(head.contains(&format!("Content-Length: {}\r\n", body.len())), "{head}");
        // Another sign-in right after listens on the same port, even after a
        // browser that didn't hang up.
        let failed = sign_in(port, "__clerk_status=failed&__clerk_error_code=oauth_access_denied", true);
        assert!(failed.contains("Sign-in didn't finish") && failed.contains(BUTTON), "{failed}");
        assert!(sign_in(port, "rotating_token_nonce=abc", false).contains("You're signed in"));
    }

    /// The button on the page, as the browser gets it.
    const BUTTON: &str = "<a href=\"thoughtdesk://open\">Open Thought Desk</a>";

    #[test]
    fn the_page_links_back_and_runs_nothing() {
        for ok in [true, false] {
            let page = page(ok);
            assert_eq!(page.matches("href=").count(), 1, "one link: {page}");
            assert_eq!(page.matches(BUTTON).count(), 1, "{page}");
            // No scripts, and nothing a script could hide in.
            let lower = page.to_lowercase();
            for banned in ["<script", "javascript:", "<iframe", "<form", "<img", "http-equiv", "src="] {
                assert!(!lower.contains(banned), "{banned:?} in {page}");
            }
            // Nor an event handler (onclick=…) on anything.
            assert!(!lower.split_whitespace().any(|word| word.starts_with("on") && word.contains('=')), "{page}");
        }
        // Nothing the browser sent ends up in the page: every return gets one of the two.
        let listener = bind(0).unwrap();
        let (_, first) = hear(&listener, None, &format!("{PATH}?rotating_token_nonce=<b>one</b>"), None);
        let (_, second) = hear(&listener, None, &format!("{PATH}?rotating_token_nonce=two&x=thoughtdesk://other"), None);
        assert_eq!(first, second);
        assert_eq!(first, page(true));
    }

    /// Every file under `dir` whose name ends in one of `kinds`, with its text.
    fn sources(dir: &std::path::Path, kinds: &[&str]) -> Vec<(std::path::PathBuf, String)> {
        let mut found = Vec::new();
        for entry in std::fs::read_dir(dir).unwrap_or_else(|e| panic!("{}: {e}", dir.display())) {
            let path = entry.unwrap().path();
            if path.is_dir() {
                found.extend(sources(&path, kinds));
            } else if kinds.iter().any(|kind| path.to_string_lossy().ends_with(kind)) {
                let text = std::fs::read_to_string(&path).unwrap();
                found.push((path, text));
            }
        }
        found
    }

    /// Any website can open a thoughtdesk:// link, so the link may only ever
    /// bring the window forward. This fails when something starts reading
    /// it: read the notes in main.rs before changing what it checks.
    #[test]
    fn the_link_only_brings_the_window_forward() {
        let tauri = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let read = |name: &str| std::fs::read_to_string(tauri.join(name)).unwrap();

        // The scheme the installers register is the page's, and the only one.
        let conf: serde_json::Value = serde_json::from_str(&read("tauri.conf.json")).unwrap();
        let schemes = &conf["plugins"]["deep-link"];
        assert_eq!(schemes, &serde_json::json!({ "desktop": { "schemes": ["thoughtdesk"] } }));
        assert_eq!(OPEN_LINK, "thoughtdesk://open");

        // The interface may not ask what link opened the app, nor register others.
        for (path, text) in sources(&tauri.join("capabilities"), &[".json"]) {
            assert!(!text.contains("deep-link"), "{} lets the interface use the link", path.display());
        }
        let package = std::fs::read_to_string(tauri.join("../package.json")).unwrap();
        assert!(!package.contains("plugin-deep-link"), "the interface doesn't need the link's plugin");
        for (path, text) in sources(&tauri.join("../src"), &[".ts", ".svelte", ".js"]) {
            for reads in ["deep-link", "onOpenUrl"] {
                assert!(!text.contains(reads), "{} reads the link ({reads})", path.display());
            }
        }

        // Nor does the app: no handler for the link, no look at how it was
        // started. (The names are in pieces so this file doesn't find itself.)
        let reads = [
            concat!("on_open", "_url"),
            concat!("DeepLink", "Ext"),
            concat!("deep_", "link()"),
            concat!("handle_cli", "_arguments"),
            concat!("env::", "args"),
        ];
        for (path, text) in sources(&tauri.join("src"), &[".rs"]) {
            for reads in reads {
                assert!(!text.contains(reads), "{} reads the link ({reads})", path.display());
            }
        }
        // Single-instance would hand the link to the plugin with this feature on…
        let single = read("Cargo.toml").lines().find(|l| l.starts_with("tauri-plugin-single-instance")).unwrap().to_string();
        assert!(!single.contains("deep-link"), "{single}");
        // …and its own callback takes the arguments without looking at them.
        assert!(read("src/main.rs").contains("tauri_plugin_single_instance::init(|app, _args, _cwd| {"));
    }

    /// One request to `listener`: what the app heard (None: it keeps
    /// waiting, and the window isn't brought forward) and what the browser got.
    fn hear(listener: &TcpListener, state: Option<&str>, path: &str, host: Option<&str>) -> (Option<String>, String) {
        let port = listener.local_addr().unwrap().port();
        let (path, host) = (path.to_string(), host.map(str::to_string).unwrap_or(format!("127.0.0.1:{port}")));
        let browser = std::thread::spawn(move || browse_host(port, &path, &host, false));
        let (stream, _) = listener.accept().unwrap();
        let heard = answer(stream, state);
        let reply = browser.join().unwrap();
        (heard, reply)
    }

    #[test]
    fn strays_neither_end_the_wait_nor_count() {
        let listener = bind(0).unwrap();
        let port = listener.local_addr().unwrap().port();
        let state = Some("s3cret");
        let strays = [
            (PATH.to_string(), None),
            (format!("{PATH}?x=1"), None),
            (format!("{PATH}?rotating_token_nonce="), None),
            (format!("{PATH}?error=access_denied"), None),
            (format!("{PATH}?rotating_token_nonce=abc"), None),
            (format!("{PATH}?rotating_token_nonce=abc&td_state=other"), None),
            (format!("{PATH}?__clerk_status=failed"), None),
            (format!("{PATH}?rotating_token_nonce=abc&td_state=s3cret"), Some("evil.example.com")),
            (format!("{PATH}?rotating_token_nonce=abc&td_state=s3cret"), Some("localhost:1")),
            ("/favicon.ico".to_string(), None),
        ];
        for (path, host) in strays {
            let (heard, reply) = hear(&listener, state, &path, host);
            assert_eq!(heard, None, "{path} {host:?}");
            assert!(reply.starts_with("HTTP/1.1 404"), "{path}: {reply}");
        }
        // The real return still arrives on the same listener afterwards.
        let real = "rotating_token_nonce=abc&td_state=s3cret".to_string();
        let (heard, reply) = hear(&listener, state, &format!("{PATH}?{real}"), None);
        assert_eq!(heard.as_deref(), Some(real.as_str()));
        assert!(reply.contains("You're signed in"));
        // Without a secret, a nonce or Clerk's failure status is enough.
        let failed = "__clerk_status=failed&__clerk_error_code=oauth_access_denied";
        let (heard, reply) = hear(&listener, None, &format!("{PATH}?{failed}"), Some(&format!("127.0.0.1:{port}")));
        assert_eq!(heard.as_deref(), Some(failed));
        assert!(reply.contains("Sign-in didn't finish"));
    }

    #[test]
    fn only_this_computers_loopback_counts() {
        assert!(is_local(&"127.0.0.1:5000".parse().unwrap()));
        for other in ["192.168.1.20:5000", "10.0.0.2:80", "[::1]:5000", "[::ffff:192.168.1.2]:80"] {
            assert!(!is_local(&other.parse().unwrap()), "{other}");
        }
        assert!(host_is("GET / HTTP/1.1\r\nHost: 127.0.0.1:47823\r\n\r\n", 47823));
        assert!(!host_is("GET / HTTP/1.1\r\nHost: localhost:47823\r\n\r\n", 47823));
        assert!(!host_is("GET / HTTP/1.1\r\n\r\n", 47823));
    }
}
