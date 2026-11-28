//! User-facing notices and the macOS screen recording permission.
//!
//! Pasta has no main window, so anything that goes wrong in the background
//! must surface as a dialog; otherwise the app just seems to do nothing.

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

#[cfg(target_os = "macos")]
const SCREEN_CAPTURE_SETTINGS: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

pub fn info(app: &AppHandle, title: &str, message: &str) {
    show(app, title, message, MessageDialogKind::Info);
}

/// Logs the error and tells the user.
pub fn error(app: &AppHandle, title: &str, message: &str) {
    log::error!("{title}: {message}");
    show(
        app,
        title,
        &format!(
            "{message}\n\nDetails stehen im Protokoll (Menüleiste → Pasta → Protokoll öffnen)."
        ),
        MessageDialogKind::Error,
    );
}

fn show(app: &AppHandle, title: &str, message: &str, kind: MessageDialogKind) {
    bring_to_front(app);
    app.dialog()
        .message(message)
        .title(title)
        .kind(kind)
        .show(|_| {});
}

const PROJECT_URL: &str = "https://github.com/cniehaus/pasty";
const HELP_URL: &str = "https://cniehaus.github.io/pasty/";

/// Opens (or focuses) the "About Pasta" window.
pub fn about(app: &AppHandle) {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    if let Some(window) = app.get_webview_window("about") {
        let _ = window.set_focus();
        return;
    }
    let built = WebviewWindowBuilder::new(app, "about", WebviewUrl::App("about.html".into()))
        .title("Über Pasta")
        .inner_size(372.0, 540.0)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .center()
        .build();
    match built {
        Ok(window) => {
            bring_to_front(app);
            let _ = window.set_focus();
        }
        Err(e) => log::error!("about window: {e}"),
    }
}

#[tauri::command]
pub fn open_project_page() {
    open_url(PROJECT_URL);
}

/// User guide (the project website).
#[tauri::command]
pub fn open_help() {
    open_url(HELP_URL);
}

#[tauri::command]
pub fn show_about(app: AppHandle) {
    about(&app);
}

/// Whether Pasta may record the screen. On macOS a newly granted permission
/// only takes effect after Pasta restarts.
#[cfg(target_os = "macos")]
pub fn screen_capture_allowed() -> bool {
    objc2_core_graphics::CGPreflightScreenCaptureAccess()
}

#[cfg(not(target_os = "macos"))]
pub fn screen_capture_allowed() -> bool {
    true
}

/// Lists Pasta in the screen recording settings and explains the next steps.
#[cfg(target_os = "macos")]
pub fn request_screen_capture(app: &AppHandle) {
    log::warn!("screen recording permission missing");
    // Adds Pasta to the list in System Settings (shows the system prompt once).
    objc2_core_graphics::CGRequestScreenCaptureAccess();

    bring_to_front(app);
    app.dialog()
        .message(
            "Für Bildschirmfotos braucht Pasta die Berechtigung „Bildschirm- & Systemaudioaufnahme“.\n\n\
             1. In den Systemeinstellungen bei Pasta den Schalter einschalten.\n\
             2. Danach Pasta neu starten: Menüleiste → Pasta → Pasta neu starten.",
        )
        .title("Bildschirmaufnahme erlauben")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Systemeinstellungen öffnen".into(),
            "Später".into(),
        ))
        .show(|open| {
            if open {
                open_url(SCREEN_CAPTURE_SETTINGS);
            }
        });
}

#[cfg(not(target_os = "macos"))]
pub fn request_screen_capture(_app: &AppHandle) {}

/// Opens a URL or folder with the system's default handler.
pub fn open_url(target: &str) {
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(target).spawn();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("explorer").arg(target).spawn();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let result = std::process::Command::new("xdg-open").arg(target).spawn();

    if let Err(e) = result {
        log::error!("could not open {target}: {e}");
    }
}

/// Menu bar apps are not frontmost by default; dialogs would open behind
/// the active app.
#[cfg(target_os = "macos")]
fn bring_to_front(app: &AppHandle) {
    let _ = app.run_on_main_thread(|| {
        if let Some(mtm) = objc2::MainThreadMarker::new() {
            objc2_app_kit::NSApplication::sharedApplication(mtm).activate();
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn bring_to_front(_app: &AppHandle) {}
