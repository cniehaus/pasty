//! Visible application windows, front to back, for window capture.
//!
//! Coordinates are native desktop coordinates, like [`crate::capture::MonitorBounds`]:
//! points on macOS, physical pixels on Windows. Pasta's own windows are
//! left out.

/// Captures a single window by id, without windows in front of it.
pub fn capture(id: u32) -> Result<image::RgbaImage, String> {
    let window = xcap::Window::all()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|w| w.id().ok() == Some(id))
        .ok_or("window no longer exists")?;
    window.capture_image().map_err(|e| e.to_string())
}

/// Windows smaller than this (in desktop units) are ignored.
const MIN_SIZE: f64 = 40.0;

#[derive(Debug, Clone)]
pub struct WindowInfo {
    /// System window id (CGWindowID on macOS, HWND on Windows).
    pub id: u32,
    pub app: String,
    pub title: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[cfg(target_os = "macos")]
pub fn visible_windows() -> Vec<WindowInfo> {
    macos::visible_windows()
}

#[cfg(not(target_os = "macos"))]
pub fn visible_windows() -> Vec<WindowInfo> {
    use std::cmp::Reverse;

    let own_pid = std::process::id();
    let Ok(windows) = xcap::Window::all() else {
        return Vec::new();
    };
    let mut list: Vec<(i32, WindowInfo)> = windows
        .iter()
        .filter(|w| !w.is_minimized().unwrap_or(true) && w.pid().ok() != Some(own_pid))
        .filter_map(|w| {
            let info = WindowInfo {
                id: w.id().ok()?,
                app: w.app_name().unwrap_or_default(),
                title: w.title().unwrap_or_default(),
                x: f64::from(w.x().ok()?),
                y: f64::from(w.y().ok()?),
                width: f64::from(w.width().ok()?),
                height: f64::from(w.height().ok()?),
            };
            Some((w.z().unwrap_or(0), info))
        })
        .filter(|(_, w)| w.width >= MIN_SIZE && w.height >= MIN_SIZE)
        .collect();
    list.sort_by_key(|(z, _)| Reverse(*z));
    list.into_iter().map(|(_, w)| w).collect()
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::c_void;

    use objc2_core_foundation::{CFDictionary, CFNumber, CFNumberType, CFString, CGRect};
    use objc2_core_graphics::{
        CGRectMakeWithDictionaryRepresentation, CGWindowListCopyWindowInfo, CGWindowListOption,
    };

    use super::{MIN_SIZE, WindowInfo};

    /// Window layer of ordinary application windows; menus, the menu bar,
    /// the Dock and overlays use higher layers.
    const NORMAL_LAYER: i32 = 0;

    pub fn visible_windows() -> Vec<WindowInfo> {
        let own_pid = std::process::id() as i32;
        let options =
            CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements;
        // 0 = no relative window.
        let Some(list) = CGWindowListCopyWindowInfo(options, 0) else {
            return Vec::new();
        };

        // The list is ordered front to back.
        (0..list.count())
            .filter_map(|i| {
                // SAFETY: the array holds CFDictionary entries and outlives `dict`.
                let dict = unsafe { (list.value_at_index(i) as *const CFDictionary).as_ref()? };
                if number(dict, "kCGWindowLayer")? != NORMAL_LAYER
                    || number(dict, "kCGWindowOwnerPID")? == own_pid
                {
                    return None;
                }
                let bounds = rect(dict, "kCGWindowBounds")?;
                Some(WindowInfo {
                    id: number(dict, "kCGWindowNumber")? as u32,
                    app: string(dict, "kCGWindowOwnerName").unwrap_or_default(),
                    title: string(dict, "kCGWindowName").unwrap_or_default(),
                    x: bounds.origin.x,
                    y: bounds.origin.y,
                    width: bounds.size.width,
                    height: bounds.size.height,
                })
            })
            .filter(|w| w.width >= MIN_SIZE && w.height >= MIN_SIZE)
            .collect()
    }

    fn value(dict: &CFDictionary, key: &str) -> Option<*const c_void> {
        let key = CFString::from_str(key);
        // SAFETY: looking up a CFString key in a live dictionary.
        let value = unsafe { dict.value((&*key as *const CFString).cast()) };
        (!value.is_null()).then_some(value)
    }

    fn number(dict: &CFDictionary, key: &str) -> Option<i32> {
        let number = value(dict, key)? as *const CFNumber;
        let mut out: i32 = 0;
        // SAFETY: the value for these keys is a CFNumber.
        let ok = unsafe { (*number).value(CFNumberType::IntType, (&mut out as *mut i32).cast()) };
        ok.then_some(out)
    }

    fn string(dict: &CFDictionary, key: &str) -> Option<String> {
        let string = value(dict, key)? as *const CFString;
        // SAFETY: the value for these keys is a CFString.
        Some(unsafe { (*string).to_string() })
    }

    fn rect(dict: &CFDictionary, key: &str) -> Option<CGRect> {
        let bounds = value(dict, key)? as *const CFDictionary;
        let mut out = CGRect::default();
        // SAFETY: the bounds value is a CGRect dictionary representation.
        let ok = unsafe { CGRectMakeWithDictionaryRepresentation(Some(&*bounds), &mut out) };
        ok.then_some(out)
    }
}

#[cfg(test)]
mod tests {
    /// Manual check: `cargo test list_windows -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn list_windows() {
        for w in super::visible_windows() {
            println!(
                "{:<24} {:>5.0} × {:<5.0} at {:.0},{:.0}",
                w.app, w.width, w.height, w.x, w.y
            );
        }
    }
}
