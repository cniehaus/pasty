//! Region selection: freezes the screen and shows a fullscreen overlay on
//! top of it, in which the user drags the region to capture.
//!
//! Flow:
//! 1. `start` captures the monitor under the cursor and opens a hidden
//!    overlay window covering it.
//! 2. The overlay page loads the frozen image and calls `overlay_ready`,
//!    which shows the window (avoids flashing an empty window).
//! 3. The page calls `finish_selection` or `cancel_selection`.

use std::{
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::{Duration, Instant},
};

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::{
    capture::{self, MonitorBounds, Region, Snapshot},
    editor, notice,
    store::{FrozenScreen, ImageStore, WindowRegion},
    window_list,
};

const LABEL: &str = "overlay";
/// If the overlay page hasn't reported ready by then, give up and reset.
const READY_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Default)]
pub struct OverlayState {
    /// Set while a capture is in progress, so that repeated shortcut
    /// presses don't start a second one.
    busy: AtomicBool,
    /// Counts captures, so a late watchdog can't close a newer overlay.
    generation: AtomicU64,
}

/// Checks the permission and claims the capture slot; false if a capture
/// can't start now.
fn begin(app: &AppHandle) -> bool {
    if !notice::screen_capture_allowed() {
        notice::request_screen_capture(app);
        return false;
    }
    if app
        .state::<OverlayState>()
        .busy
        .swap(true, Ordering::AcqRel)
    {
        log::info!("capture already in progress");
        return false;
    }
    true
}

/// Captures the whole monitor under the cursor straight into the editor.
pub fn capture_full_screen(app: &AppHandle) {
    if !begin(app) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let result = capture::snapshot_monitor_under_cursor(&app)
            .and_then(|snapshot| editor::open(&app, &snapshot.image));
        app.state::<OverlayState>()
            .busy
            .store(false, Ordering::Release);
        if let Err(e) = result {
            notice::error(&app, "Aufnahme fehlgeschlagen", &e);
        }
    });
}

/// Freezes the screen and lets the user select a region.
pub fn start(app: &AppHandle) {
    start_after(app, 0);
}

/// Like [`start`], but freezes the screen only after a countdown, so that
/// menus or tooltips can be opened first. The countdown is shown next to
/// the menu bar icon (tooltip on Windows) instead of in a window, which
/// would take the focus and close an open menu.
pub fn start_after(app: &AppHandle, seconds: u64) {
    if !begin(app) {
        return;
    }
    let state = app.state::<OverlayState>();
    let generation = state.generation.fetch_add(1, Ordering::AcqRel) + 1;

    let app = app.clone();
    std::thread::spawn(move || {
        for remaining in (1..=seconds).rev() {
            show_countdown(&app, Some(remaining));
            std::thread::sleep(Duration::from_secs(1));
        }
        if seconds > 0 {
            show_countdown(&app, None);
        }

        if let Err(e) = freeze_and_open(&app) {
            close(&app);
            notice::error(&app, "Aufnahme fehlgeschlagen", &e);
            return;
        }
        std::thread::sleep(READY_TIMEOUT);
        watchdog(&app, generation);
    });
}

fn show_countdown(app: &AppHandle, remaining: Option<u64>) {
    let Some(tray) = app.tray_by_id(crate::TRAY_ID) else {
        return;
    };
    let _ = tray.set_title(remaining.map(|s| s.to_string()));
    let _ = tray.set_tooltip(Some(match remaining {
        Some(s) => format!("Pasta – Aufnahme in {s} s"),
        None => "Pasta".to_owned(),
    }));
}

/// Resets a capture whose overlay never became visible, so that Pasta
/// doesn't stay blocked.
fn watchdog(app: &AppHandle, generation: u64) {
    let current = app
        .state::<OverlayState>()
        .generation
        .load(Ordering::Acquire);
    let stuck = current == generation
        && app
            .get_webview_window(LABEL)
            .is_some_and(|w| !w.is_visible().unwrap_or(false));
    if stuck {
        close(app);
        notice::error(
            app,
            "Auswahl konnte nicht angezeigt werden",
            "Das Auswahlfenster ist nicht erschienen. Bitte noch einmal versuchen.",
        );
    }
}

fn freeze_and_open(app: &AppHandle) -> Result<(), String> {
    let started = Instant::now();
    let snapshot = capture::snapshot_monitor_under_cursor(app)?;
    let captured = started.elapsed();
    let png = capture::encode_png(&snapshot.image)?;
    log::info!(
        "frozen {}x{} px (capture {captured:?}, encode {:?})",
        snapshot.image.width(),
        snapshot.image.height(),
        started.elapsed() - captured
    );

    app.state::<ImageStore>().set_frozen(
        FrozenScreen {
            windows: window_regions(&snapshot),
            image: snapshot.image,
        },
        png,
    );
    open_window(app, snapshot.bounds).map_err(|e| e.to_string())
}

/// Visible windows on the captured monitor, as rectangles in the image.
fn window_regions(snapshot: &Snapshot) -> Vec<WindowRegion> {
    let b = snapshot.bounds;
    let (img_w, img_h) = (
        f64::from(snapshot.image.width()),
        f64::from(snapshot.image.height()),
    );
    // Desktop units (points on macOS) to image pixels.
    let scale = img_w / f64::from(b.width);
    window_list::visible_windows()
        .into_iter()
        .filter_map(|w| {
            let x0 = ((w.x - f64::from(b.x)) * scale).clamp(0.0, img_w).round();
            let y0 = ((w.y - f64::from(b.y)) * scale).clamp(0.0, img_h).round();
            let x1 = ((w.x + w.width - f64::from(b.x)) * scale)
                .clamp(0.0, img_w)
                .round();
            let y1 = ((w.y + w.height - f64::from(b.y)) * scale)
                .clamp(0.0, img_h)
                .round();
            if x1 - x0 < 1.0 || y1 - y0 < 1.0 {
                return None; // on another monitor
            }
            let label = if w.title.is_empty() {
                w.app
            } else {
                format!("{} – {}", w.app, w.title)
            };
            Some(WindowRegion {
                id: w.id,
                x: x0 as u32,
                y: y0 as u32,
                width: (x1 - x0) as u32,
                height: (y1 - y0) as u32,
                label,
            })
        })
        .collect()
}

fn open_window(app: &AppHandle, bounds: MonitorBounds) -> tauri::Result<()> {
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("overlay.html".into()))
        .title("Pasta")
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .visible(false)
        .build()?;

    // Raise first so AppKit doesn't constrain the frame below the menu bar.
    #[cfg(target_os = "macos")]
    raise_above_menu_bar(&window)?;

    place_over_monitor(&window, bounds)
}

#[cfg(target_os = "macos")]
fn place_over_monitor(window: &WebviewWindow, b: MonitorBounds) -> tauri::Result<()> {
    use tauri::{LogicalPosition, LogicalSize};
    // Size first: AppKit keeps the bottom-left corner fixed on resize, so
    // resizing after positioning would push the window off the top edge.
    window.set_size(LogicalSize::new(b.width, b.height))?;
    window.set_position(LogicalPosition::new(b.x, b.y))
}

#[cfg(not(target_os = "macos"))]
fn place_over_monitor(window: &WebviewWindow, b: MonitorBounds) -> tauri::Result<()> {
    use tauri::{PhysicalPosition, PhysicalSize};
    window.set_size(PhysicalSize::new(b.width, b.height))?;
    window.set_position(PhysicalPosition::new(b.x, b.y))
}

/// Regular always-on-top windows stay below the menu bar and the Dock.
#[cfg(target_os = "macos")]
fn raise_above_menu_bar(window: &WebviewWindow) -> tauri::Result<()> {
    use objc2_app_kit::{NSScreenSaverWindowLevel, NSWindow, NSWindowCollectionBehavior};

    // Raw pointers are not `Send`; pass the address to the main thread.
    let ns_window = window.ns_window()? as usize;
    window.run_on_main_thread(move || {
        // SAFETY: the pointer comes from the live overlay window and AppKit
        // objects are only touched on the main thread.
        let ns_window = unsafe { &*(ns_window as *const NSWindow) };
        ns_window.setLevel(NSScreenSaverWindowLevel);
        ns_window.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary,
        );
    })
}

fn close(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.destroy();
    }
    app.state::<ImageStore>().take_frozen();
    app.state::<OverlayState>()
        .busy
        .store(false, Ordering::Release);
}

// Commands are `async` so they run off the main thread; creating windows
// from a synchronous command can deadlock on Windows.

#[tauri::command]
pub async fn overlay_ready(window: WebviewWindow) -> Result<(), String> {
    log::info!("overlay ready");
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

/// Windows under the frozen screen, for click-to-capture in the overlay.
#[tauri::command]
pub fn frozen_windows(app: AppHandle) -> Vec<WindowRegion> {
    app.state::<ImageStore>().frozen_windows()
}

#[tauri::command]
pub async fn cancel_selection(app: AppHandle) {
    close(&app);
}

/// Takes a single window on its own (without windows in front of it).
/// Falls back to cutting `region` out of the frozen screen.
#[tauri::command]
pub async fn finish_window(app: AppHandle, id: u32, region: Region) -> Result<(), String> {
    let frozen = app
        .state::<ImageStore>()
        .take_frozen()
        .ok_or("no frozen screen")?;
    close(&app);

    let image = match window_list::capture(id) {
        Ok(image) => image,
        Err(e) => {
            log::warn!("window capture failed ({e}); using the frozen screen");
            capture::crop(&frozen.image, region)?
        }
    };
    editor::open(&app, &image)
}

#[tauri::command]
pub async fn finish_selection(app: AppHandle, region: Region) -> Result<(), String> {
    let frozen = app
        .state::<ImageStore>()
        .take_frozen()
        .ok_or("no frozen screen")?;
    close(&app);

    let image = capture::crop(&frozen.image, region)?;
    editor::open(&app, &image)
}
