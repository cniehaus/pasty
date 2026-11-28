//! The editor window: one window for all recent captures, with a film strip.
//!
//! New captures are added to the store and announced to an open editor via
//! the `capture-added` event; otherwise the editor window is created and
//! loads all captures itself (`list_captures`).

use image::RgbaImage;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::{capture, notice, overlay, store::ImageStore};

const LABEL: &str = "editor";
const MIN_SIZE: (f64, f64) = (960.0, 600.0);
const DEFAULT_SIZE: (f64, f64) = (1240.0, 800.0);

/// Adds a finished capture and shows it in the editor.
pub fn open(app: &AppHandle, image: &RgbaImage) -> Result<(), String> {
    let png = capture::encode_png(image)?;
    let id = app.state::<ImageStore>().add_capture(png);
    log::info!("capture {id}: {}x{} px", image.width(), image.height());

    match app.get_webview_window(LABEL) {
        Some(window) => {
            window
                .emit("capture-added", id)
                .map_err(|e| e.to_string())?;
            focus(&window);
            Ok(())
        }
        None => create(app),
    }
}

/// Opens (or focuses) the editor with the recent captures.
pub fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        focus(&window);
    } else if app.state::<ImageStore>().captures().is_empty() {
        notice::info(
            app,
            "Noch keine Aufnahmen",
            "Mit „Bereich aufnehmen“ (⌘⇧2 bzw. Strg+Umschalt+2) entsteht die erste Aufnahme.",
        );
    } else if let Err(e) = create(app) {
        notice::error(app, "Editor konnte nicht geöffnet werden", &e);
    }
}

fn create(app: &AppHandle) -> Result<(), String> {
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("editor.html".into()))
        .title(format!("Pasta {}", app.package_info().version))
        .inner_size(DEFAULT_SIZE.0, DEFAULT_SIZE.1)
        .min_inner_size(MIN_SIZE.0, MIN_SIZE.1)
        .center()
        .build()
        .map_err(|e| e.to_string())?;
    focus(&window);
    Ok(())
}

fn focus(window: &tauri::WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

// Commands used by the editor page.

/// Capture ids, oldest first.
#[tauri::command]
pub fn list_captures(app: AppHandle) -> Vec<u32> {
    app.state::<ImageStore>().captures()
}

#[tauri::command]
pub fn remove_capture(app: AppHandle, id: u32) {
    app.state::<ImageStore>().remove_capture(id);
}

#[tauri::command]
pub fn save_annotations(app: AppHandle, id: u32, json: String) {
    app.state::<ImageStore>().set_annotations(id, json);
}

#[tauri::command]
pub fn load_annotations(app: AppHandle, id: u32) -> Option<String> {
    app.state::<ImageStore>().annotations(id)
}

/// "New capture" from the editor's film strip.
#[tauri::command]
pub fn start_capture(app: AppHandle) {
    overlay::start(&app);
}
