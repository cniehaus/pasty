//! Editor windows, one per capture.
//!
//! The window label is `editor-<capture id>`; the page derives the image URL
//! from it.

use image::RgbaImage;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::{capture, store::ImageStore};

const MIN_SIZE: (f64, f64) = (480.0, 320.0);
const MAX_INITIAL_SIZE: (f64, f64) = (1200.0, 800.0);
/// Room around the image for toolbar and margins.
const CHROME: (f64, f64) = (48.0, 96.0);

pub fn open(app: &AppHandle, image: &RgbaImage, scale_factor: f64) -> Result<(), String> {
    let png = capture::encode_png(image)?;
    let id = app.state::<ImageStore>().add_capture(png);
    let (width, height) = initial_size(image.width(), image.height(), scale_factor);

    let window = WebviewWindowBuilder::new(
        app,
        format!("editor-{id}"),
        WebviewUrl::App("editor.html".into()),
    )
    .title("Pasta")
    .inner_size(width, height)
    .min_inner_size(MIN_SIZE.0, MIN_SIZE.1)
    .center()
    .build()
    .map_err(|e| e.to_string())?;

    let app_handle = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Destroyed = event {
            app_handle.state::<ImageStore>().remove_capture(id);
        }
    });
    window.set_focus().map_err(|e| e.to_string())
}

/// Window size in logical points: the image at 100 % plus chrome, clamped.
fn initial_size(width_px: u32, height_px: u32, scale_factor: f64) -> (f64, f64) {
    let scale = if scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };
    let width = f64::from(width_px) / scale + CHROME.0;
    let height = f64::from(height_px) / scale + CHROME.1;
    (
        width.clamp(MIN_SIZE.0, MAX_INITIAL_SIZE.0),
        height.clamp(MIN_SIZE.1, MAX_INITIAL_SIZE.1),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_size_converts_to_points_and_clamps() {
        assert_eq!(initial_size(1000, 600, 2.0), (548.0, 396.0));
        assert_eq!(initial_size(10, 10, 1.0), MIN_SIZE);
        assert_eq!(initial_size(10_000, 10_000, 1.0), MAX_INITIAL_SIZE);
    }
}
