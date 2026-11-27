//! Pasta core.
//!
//! Wires up the application: tray icon, global shortcut and, later on,
//! screen capture, editor windows and text snippets.
//!
//! Pasta has no main window. It lives in the menu bar (macOS) or the
//! notification area of the taskbar (Windows).

mod capture;
mod editor;
mod export;
mod notice;
mod overlay;
mod store;

use std::borrow::Cow;

use tauri::{
    AppHandle, Manager, RunEvent,
    http::{Response, StatusCode, header},
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// Primary modifier key: Cmd on macOS, Ctrl elsewhere.
#[cfg(target_os = "macos")]
const PRIMARY: Modifiers = Modifiers::SUPER;
#[cfg(not(target_os = "macos"))]
const PRIMARY: Modifiers = Modifiers::CONTROL;

/// Shortcut for "capture region": Cmd+Shift+2 / Ctrl+Shift+2.
/// (Cmd+Shift+3/4/5 are already taken by macOS.)
fn capture_shortcut() -> Shortcut {
    Shortcut::new(Some(PRIMARY | Modifiers::SHIFT), Code::Digit2)
}

/// Triggered by the global shortcut or the tray menu.
fn start_capture(app: &AppHandle) {
    overlay::start(app);
}

/// Serves images from the [`store::ImageStore`] to the webviews.
///
/// URLs look like `pasta://localhost/frozen.png` (macOS) or
/// `http://pasta.localhost/frozen.png` (Windows); the frontend builds them
/// with `convertFileSrc(path, "pasta")`.
fn serve_image(app: &AppHandle, path: &str) -> Response<Cow<'static, [u8]>> {
    let path = path.trim_start_matches('/');
    let builder = Response::builder()
        .header(header::CACHE_CONTROL, "no-store")
        // The page origin differs from pasta://; without CORS the editor
        // canvas becomes tainted and cannot be exported.
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    let response = match app.state::<store::ImageStore>().get(path) {
        Some(png) => builder
            .header(header::CONTENT_TYPE, "image/png")
            .body(Cow::Owned(png.to_vec())),
        None => builder
            .status(StatusCode::NOT_FOUND)
            .body(Cow::Borrowed(&[][..])),
    };
    response.expect("valid static response")
}

/// Menu bar icon: a black template image that macOS tints for light and
/// dark menu bars (source: `assets/icon/tray-icon.svg`).
#[cfg(target_os = "macos")]
fn tray_icon(_app: &AppHandle) -> tauri::Result<(Image<'static>, bool)> {
    Ok((
        Image::from_bytes(include_bytes!("../icons/tray-icon.png"))?,
        true,
    ))
}

/// Elsewhere the coloured app icon; a black glyph would vanish on a dark
/// taskbar.
#[cfg(not(target_os = "macos"))]
fn tray_icon(app: &AppHandle) -> tauri::Result<(Image<'static>, bool)> {
    let icon = app
        .default_window_icon()
        .cloned()
        .expect("app icon missing")
        .to_owned();
    Ok((icon, false))
}

fn open_log_dir(app: &AppHandle) {
    match app.path().app_log_dir() {
        Ok(dir) => notice::open_url(&dir.to_string_lossy()),
        Err(e) => log::error!("no log dir: {e}"),
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let capture = MenuItem::with_id(
        app,
        "capture",
        "Bereich aufnehmen",
        true,
        Some("CmdOrCtrl+Shift+2"), // display hint only
    )?;
    let logs = MenuItem::with_id(app, "logs", "Protokoll öffnen", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "Pasta neu starten", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Pasta beenden", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&capture, &separator, &logs, &restart, &quit])?;

    let (icon, is_template) = tray_icon(app)?;
    TrayIconBuilder::with_id("pasta-tray")
        .icon(icon)
        .icon_as_template(is_template)
        .tooltip("Pasta")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "capture" => start_capture(app),
            "logs" => open_log_dir(app),
            "restart" => app.restart(),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(store::ImageStore::default())
        .manage(overlay::OverlayState::default())
        .register_uri_scheme_protocol("pasta", |ctx, request| {
            serve_image(ctx.app_handle(), request.uri().path())
        })
        .invoke_handler(tauri::generate_handler![
            overlay::overlay_ready,
            overlay::cancel_selection,
            overlay::finish_selection,
            export::copy_png,
            export::save_png,
        ])
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if *shortcut == capture_shortcut() && event.state() == ShortcutState::Pressed {
                        start_capture(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            // No Dock icon; Pasta lives in the menu bar only.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            log::info!("Pasta {} started", app.package_info().version);
            build_tray(app.handle())?;
            if let Err(e) = app.global_shortcut().register(capture_shortcut()) {
                // Another app may own the shortcut; the tray menu still works.
                notice::error(
                    app.handle(),
                    "Tastenkürzel nicht verfügbar",
                    &format!("Das Kürzel für „Bereich aufnehmen“ ist bereits belegt ({e}). Die Aufnahme geht weiterhin über das Menüleisten-Symbol."),
                );
            }
            if !notice::screen_capture_allowed() {
                notice::request_screen_capture(app.handle());
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Pasta");

    app.run(|app, event| match event {
        // Keep running in the background when the last window (e.g. the
        // editor) is closed. Only an explicit exit (tray "quit") ends the app.
        RunEvent::ExitRequested {
            api, code: None, ..
        } => api.prevent_exit(),
        // Opening Pasta again while it runs: point to the menu bar icon.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } => notice::info(
            app,
            "Pasta läuft bereits",
            "Pasta findest du oben rechts in der Menüleiste (Ravioli-Symbol).\n\nBereich aufnehmen: ⌘⇧2",
        ),
        _ => {}
    });
}
