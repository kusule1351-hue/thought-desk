//! Keeps the app light while it isn't being looked at.
//!
//! When the window is minimized we hide the WebView, ask it to suspend (which
//! pauses script and lets WebView2 drop GPU and renderer resources), and lower
//! its memory target so caches are trimmed. All of it is undone as soon as
//! the window is restored. Unsaved edits are flushed by the frontend when the
//! page becomes hidden, before the suspend takes effect.
//!
//! While the window stays visible but unfocused for a while (you're working in
//! another app), we only lower the memory target, so WebView2 drops its
//! graphics and decode caches without pausing anything. Focus brings it back.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use tauri::{Manager, Runtime, Window, WindowEvent};

static LOW: AtomicBool = AtomicBool::new(false);

/// Bumped on every focus change, so a pending idle trim can tell it is stale.
static FOCUS_GEN: AtomicU64 = AtomicU64::new(0);
static IDLE_TRIMMED: AtomicBool = AtomicBool::new(false);
const IDLE_AFTER: Duration = Duration::from_secs(45);

pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if let WindowEvent::Focused(focused) = event {
        on_focus_change(window, *focused);
        return;
    }
    // Closed while minimized (from the taskbar): the page saves and then closes
    // the window itself, which a suspended page can't do, so the app would sit
    // there until the window was opened again. Wake it first.
    if matches!(event, WindowEvent::CloseRequested { .. }) {
        if LOW.swap(false, Ordering::Relaxed) {
            if let Some(webview) = window.app_handle().get_webview_window(window.label()) {
                set_low_memory(&webview, false);
            }
        }
        return;
    }
    if !matches!(event, WindowEvent::Resized(_)) {
        return;
    }
    let minimized = window.is_minimized().unwrap_or(false);
    if LOW.swap(minimized, Ordering::Relaxed) == minimized {
        return;
    }
    if let Some(webview) = window.app_handle().get_webview_window(window.label()) {
        set_low_memory(&webview, minimized);
    }
}

fn on_focus_change<R: Runtime>(window: &Window<R>, focused: bool) {
    let generation = FOCUS_GEN.fetch_add(1, Ordering::Relaxed) + 1;
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    if focused {
        if IDLE_TRIMMED.swap(false, Ordering::Relaxed) && !LOW.load(Ordering::Relaxed) {
            if let Some(webview) = app.get_webview_window(&label) {
                set_memory_target(&webview, false);
            }
        }
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(IDLE_AFTER);
        // Still unfocused since then, and not minimized (that path does more).
        if FOCUS_GEN.load(Ordering::Relaxed) != generation || LOW.load(Ordering::Relaxed) {
            return;
        }
        if let Some(webview) = app.get_webview_window(&label) {
            set_memory_target(&webview, true);
            IDLE_TRIMMED.store(true, Ordering::Relaxed);
        }
    });
}

/// Bumped by every `trim`, so only the latest one restores the target.
static TRIM_GEN: AtomicU64 = AtomicU64::new(0);
/// Long enough for WebView2 to act on the low target and drop its caches.
const TRIM_FOR: Duration = Duration::from_millis(1500);

/// Drops graphics and decode caches right away, after closing something
/// expensive to draw (Settings), instead of whenever Chromium gets to it.
/// The target goes low briefly, then back to normal; nothing is paused.
pub fn trim<R: Runtime>(webview: tauri::WebviewWindow<R>) {
    // Minimized or idle-trimmed: the target is already low and owned there.
    if LOW.load(Ordering::Relaxed) || IDLE_TRIMMED.load(Ordering::Relaxed) {
        return;
    }
    let generation = TRIM_GEN.fetch_add(1, Ordering::Relaxed) + 1;
    set_memory_target(&webview, true);
    std::thread::spawn(move || {
        std::thread::sleep(TRIM_FOR);
        let superseded = TRIM_GEN.load(Ordering::Relaxed) != generation;
        if !superseded && !LOW.load(Ordering::Relaxed) && !IDLE_TRIMMED.load(Ordering::Relaxed) {
            set_memory_target(&webview, false);
        }
    });
}

/// Only the memory target: the page keeps running and stays visible.
#[cfg(windows)]
fn set_memory_target<R: Runtime>(webview: &tauri::WebviewWindow<R>, low: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows_core::Interface;

    let _ = webview.with_webview(move |wv| unsafe {
        let Ok(core) = wv.controller().CoreWebView2() else { return };
        if let Ok(core19) = core.cast::<ICoreWebView2_19>() {
            let level = if low { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL };
            let _ = core19.SetMemoryUsageTargetLevel(level);
        }
    });
}

#[cfg(not(windows))]
fn set_memory_target<R: Runtime>(_webview: &tauri::WebviewWindow<R>, _low: bool) {}

#[cfg(windows)]
fn set_low_memory<R: Runtime>(webview: &tauri::WebviewWindow<R>, low: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, ICoreWebView2_3, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use webview2_com::TrySuspendCompletedHandler;
    use windows_core::Interface;

    let _ = webview.with_webview(move |wv| unsafe {
        let controller = wv.controller();
        let Ok(core) = controller.CoreWebView2() else { return };
        // Each step needs a newer WebView2 runtime; older ones just skip it.
        let level = if low {
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
        } else {
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
        };
        if let Ok(core19) = core.cast::<ICoreWebView2_19>() {
            let _ = core19.SetMemoryUsageTargetLevel(level);
        }
        let core3 = core.cast::<ICoreWebView2_3>().ok();
        if low {
            // Suspending requires the WebView to be hidden first.
            let _ = controller.SetIsVisible(false);
            if let Some(core3) = core3 {
                let _ = core3.TrySuspend(&TrySuspendCompletedHandler::create(Box::new(|_, _| Ok(()))));
            }
        } else {
            if let Some(core3) = core3 {
                let _ = core3.Resume();
            }
            let _ = controller.SetIsVisible(true);
        }
    });
}

#[cfg(not(windows))]
fn set_low_memory<R: Runtime>(_webview: &tauri::WebviewWindow<R>, _low: bool) {}
