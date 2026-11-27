//! Pasta core.
//!
//! Wires up the application: tray icon, global shortcut and, later on,
//! screen capture, editor windows and text snippets.
//!
//! Pasta has no main window. It lives in the menu bar (macOS) or the
//! notification area of the taskbar (Windows).

use tauri::{
    AppHandle, RunEvent,
    menu::{Menu, MenuItem},
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
///
/// Placeholder: will freeze the screen and open the selection overlay.
fn start_capture(_app: &AppHandle) {
    println!("[pasta] capture triggered");
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let capture = MenuItem::with_id(
        app,
        "capture",
        "Bereich aufnehmen",
        true,
        Some("CmdOrCtrl+Shift+2"), // display hint only
    )?;
    let quit = MenuItem::with_id(app, "quit", "Pasta beenden", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&capture, &quit])?;

    TrayIconBuilder::with_id("pasta-tray")
        // TODO: dedicated monochrome tray icon.
        .icon(
            app.default_window_icon()
                .cloned()
                .expect("app icon missing"),
        )
        .tooltip("Pasta")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "capture" => start_capture(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
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

            build_tray(app.handle())?;
            app.global_shortcut().register(capture_shortcut())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Pasta");

    app.run(|_app, event| {
        // Keep running in the background when the last window (e.g. the
        // editor) is closed. Only an explicit exit (tray "quit") ends the app.
        if let RunEvent::ExitRequested {
            api, code: None, ..
        } = event
        {
            api.prevent_exit();
        }
    });
}
