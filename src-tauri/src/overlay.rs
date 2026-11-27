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
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::{
    capture::{self, MonitorBounds, Region},
    editor,
    store::{FrozenScreen, ImageStore},
};

const LABEL: &str = "overlay";

/// Set while a capture is in progress, so that repeated shortcut presses
/// don't start a second one.
#[derive(Default)]
pub struct OverlayState {
    busy: AtomicBool,
}

pub fn start(app: &AppHandle) {
    let state = app.state::<OverlayState>();
    if state.busy.swap(true, Ordering::AcqRel) {
        return;
    }

    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = freeze_and_open(&app) {
            eprintln!("[pasta] capture failed: {e}");
            close(&app);
        }
    });
}

fn freeze_and_open(app: &AppHandle) -> Result<(), String> {
    let started = Instant::now();
    let snapshot = capture::snapshot_monitor_under_cursor(app)?;
    let captured = started.elapsed();
    let png = capture::encode_png(&snapshot.image)?;
    println!(
        "[pasta] frozen {}x{} px (capture {captured:?}, encode {:?})",
        snapshot.image.width(),
        snapshot.image.height(),
        started.elapsed() - captured
    );

    app.state::<ImageStore>().set_frozen(
        FrozenScreen {
            image: snapshot.image,
            scale_factor: snapshot.scale_factor,
        },
        png,
    );
    open_window(app, snapshot.bounds).map_err(|e| e.to_string())
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
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cancel_selection(app: AppHandle) {
    close(&app);
}

#[tauri::command]
pub async fn finish_selection(app: AppHandle, region: Region) -> Result<(), String> {
    let frozen = app
        .state::<ImageStore>()
        .take_frozen()
        .ok_or("no frozen screen")?;
    close(&app);

    let image = capture::crop(&frozen.image, region)?;
    editor::open(&app, &image, frozen.scale_factor).map_err(|e| e.to_string())
}
