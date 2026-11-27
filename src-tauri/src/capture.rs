//! Screen capture and image helpers.

use image::{
    ExtendedColorType, ImageEncoder, RgbaImage,
    codecs::png::{CompressionType, FilterType, PngEncoder},
};
use serde::Deserialize;
use tauri::AppHandle;
use xcap::Monitor;

/// Monitor bounds in native desktop coordinates: points on macOS,
/// physical pixels on Windows.
#[derive(Debug, Clone, Copy)]
pub struct MonitorBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

pub struct Snapshot {
    pub image: RgbaImage,
    pub bounds: MonitorBounds,
    pub scale_factor: f64,
}

/// Selected region in image pixels.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Region {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// Captures the full monitor the mouse cursor is on (primary as fallback).
pub fn snapshot_monitor_under_cursor(app: &AppHandle) -> Result<Snapshot, String> {
    let monitor = cursor_position(app)
        .and_then(|(x, y)| Monitor::from_point(x, y).ok())
        .or_else(primary_monitor)
        .ok_or("no monitor found")?;

    let bounds = MonitorBounds {
        x: monitor.x().map_err(err)?,
        y: monitor.y().map_err(err)?,
        width: monitor.width().map_err(err)?,
        height: monitor.height().map_err(err)?,
    };
    let scale_factor = f64::from(monitor.scale_factor().map_err(err)?);
    let image = monitor.capture_image().map_err(err)?;

    Ok(Snapshot {
        image,
        bounds,
        scale_factor,
    })
}

/// Returns a copy of `region`, which must lie fully inside `image`.
pub fn crop(image: &RgbaImage, region: Region) -> Result<RgbaImage, String> {
    let fits = region.width > 0
        && region.height > 0
        && region
            .x
            .checked_add(region.width)
            .is_some_and(|r| r <= image.width())
        && region
            .y
            .checked_add(region.height)
            .is_some_and(|b| b <= image.height());
    if !fits {
        return Err(format!(
            "region {region:?} outside of {}x{} image",
            image.width(),
            image.height()
        ));
    }
    Ok(
        image::imageops::crop_imm(image, region.x, region.y, region.width, region.height)
            .to_image(),
    )
}

/// Encodes as PNG, favouring speed over file size.
pub fn encode_png(image: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut png = Vec::new();
    PngEncoder::new_with_quality(&mut png, CompressionType::Fast, FilterType::Sub)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            ExtendedColorType::Rgba8,
        )
        .map_err(err)?;
    Ok(png)
}

fn primary_monitor() -> Option<Monitor> {
    Monitor::all()
        .ok()?
        .into_iter()
        .find(|m| m.is_primary().unwrap_or(false))
}

/// Cursor position in the same coordinate space as `Monitor::from_point`.
#[cfg(target_os = "macos")]
fn cursor_position(_app: &AppHandle) -> Option<(i32, i32)> {
    use objc2_core_graphics::CGEvent;

    // Global display coordinates in points, origin top-left.
    let event = CGEvent::new(None)?;
    let point = CGEvent::location(Some(&event));
    Some((point.x as i32, point.y as i32))
}

#[cfg(not(target_os = "macos"))]
fn cursor_position(app: &AppHandle) -> Option<(i32, i32)> {
    let position = app.cursor_position().ok()?;
    Some((position.x as i32, position.y as i32))
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn region(x: u32, y: u32, width: u32, height: u32) -> Region {
        Region {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn crop_returns_requested_size() {
        let image = RgbaImage::new(100, 50);
        let cropped = crop(&image, region(10, 5, 30, 20)).unwrap();
        assert_eq!(cropped.dimensions(), (30, 20));
    }

    #[test]
    fn crop_rejects_regions_outside_or_empty() {
        let image = RgbaImage::new(100, 50);
        assert!(crop(&image, region(90, 0, 20, 10)).is_err());
        assert!(crop(&image, region(0, 0, 0, 10)).is_err());
        assert!(crop(&image, region(u32::MAX, 0, 2, 2)).is_err());
    }

    #[test]
    fn encoded_png_has_signature() {
        let png = encode_png(&RgbaImage::new(4, 4)).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    }
}
