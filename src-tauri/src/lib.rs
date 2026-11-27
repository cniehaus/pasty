//! Pasta – Rust-Kern.
//!
//! Hier wird die App zusammengesetzt: Tray-Icon (Menüleiste), globales
//! Tastenkürzel und später Aufnahme, Editor-Fenster und Textbausteine.
//!
//! Pasta hat kein Hauptfenster. Die App lebt in der Menüleiste (macOS) bzw.
//! im Infobereich der Taskleiste (Windows).

use tauri::{
    AppHandle, RunEvent,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// Die „Haupt-Modifikatortaste“: ⌘ auf dem Mac, Strg auf Windows.
///
/// `#[cfg(...)]` ist bedingte Kompilierung: Der Compiler übernimmt je nach
/// Zielplattform nur eine der beiden Zeilen. So bleibt Windows mitgedacht,
/// ohne dass es zur Laufzeit eine Abfrage braucht.
#[cfg(target_os = "macos")]
const PRIMARY: Modifiers = Modifiers::SUPER;
#[cfg(not(target_os = "macos"))]
const PRIMARY: Modifiers = Modifiers::CONTROL;

/// Tastenkürzel für „Bereich aufnehmen“: ⌘⇧2 bzw. Strg+Umschalt+2.
/// (⌘⇧3/4/5 belegt macOS bereits selbst.)
fn capture_shortcut() -> Shortcut {
    Shortcut::new(Some(PRIMARY | Modifiers::SHIFT), Code::Digit2)
}

/// Wird ausgelöst per Tastenkürzel oder Tray-Menü.
///
/// Noch ein Platzhalter – im nächsten Schritt friert das hier den Bildschirm
/// ein und öffnet das Auswahl-Overlay.
fn start_capture(_app: &AppHandle) {
    println!("[pasta] Aufnahme ausgelöst");
}

/// Baut das Tray-Icon mit seinem Menü.
///
/// Der Rückgabetyp `tauri::Result<()>` bedeutet: entweder Erfolg ohne Wert
/// (`()`), oder ein Fehler. Das `?` hinter einem Aufruf reicht einen Fehler
/// sofort an den Aufrufer weiter – ähnlich wie eine Exception, aber explizit.
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let capture = MenuItem::with_id(
        app,
        "capture",
        "Bereich aufnehmen",
        true,
        Some("CmdOrCtrl+Shift+2"), // wird im Menü nur als Hinweis angezeigt
    )?;
    let quit = MenuItem::with_id(app, "quit", "Pasta beenden", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&capture, &quit])?;

    TrayIconBuilder::with_id("pasta-tray")
        // Vorerst das App-Icon; ein eigenes Menüleisten-Icon folgt später.
        .icon(app.default_window_icon().cloned().expect("App-Icon fehlt"))
        .tooltip("Pasta")
        .menu(&menu)
        .show_menu_on_left_click(true)
        // `|app, event| …` ist eine Closure (anonyme Funktion), ähnlich
        // `(app, event) => …` in JavaScript.
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
                    // Nur beim Drücken reagieren, nicht beim Loslassen.
                    if *shortcut == capture_shortcut() && event.state() == ShortcutState::Pressed {
                        start_capture(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            // macOS: kein Dock-Icon, Pasta lebt nur in der Menüleiste.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            build_tray(app.handle())?;
            app.global_shortcut().register(capture_shortcut())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Pasta konnte nicht gestartet werden");

    app.run(|_app, event| {
        // Normalerweise beendet sich eine Tauri-App, wenn das letzte Fenster
        // geschlossen wird. Pasta soll aber im Hintergrund weiterlaufen, wenn
        // z. B. der Editor zugemacht wird. Nur „Pasta beenden“ (exit mit
        // Code) beendet die App wirklich.
        if let RunEvent::ExitRequested {
            api, code: None, ..
        } = event
        {
            api.prevent_exit();
        }
    });
}
