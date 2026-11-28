//! In-memory image store.
//!
//! Images never touch the disk until the user saves them. The webviews load
//! them through the custom `pasta://` protocol (see `lib.rs`), which looks
//! them up here by path, e.g. `frozen.png` or `capture-3.png`.

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU32, Ordering},
    },
};

use image::RgbaImage;

pub const FROZEN_PATH: &str = "frozen.png";
/// Captures kept for the editor's film strip; older ones are dropped.
pub const MAX_CAPTURES: usize = 20;

/// Full-monitor snapshot shown in the selection overlay.
pub struct FrozenScreen {
    pub image: RgbaImage,
    /// Windows visible when the screen was frozen, front to back.
    pub windows: Vec<WindowRegion>,
}

/// A window's area in the frozen image, in image pixels.
#[derive(Debug, Clone, serde::Serialize)]
pub struct WindowRegion {
    /// System window id, for capturing the window on its own.
    pub id: u32,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub label: String,
}

#[derive(Default)]
pub struct ImageStore {
    frozen: Mutex<Option<FrozenScreen>>,
    files: Mutex<HashMap<String, Arc<Vec<u8>>>>,
    next_capture_id: AtomicU32,
    /// Capture ids, oldest first.
    captures: Mutex<Vec<u32>>,
    /// Editor annotations per capture (JSON owned by the frontend), so they
    /// survive closing the editor window.
    annotations: Mutex<HashMap<u32, String>>,
}

impl ImageStore {
    pub fn set_frozen(&self, frozen: FrozenScreen, png: Vec<u8>) {
        *self.frozen.lock().expect("store poisoned") = Some(frozen);
        self.insert(FROZEN_PATH.to_owned(), png);
    }

    /// Windows of the current frozen screen, front to back.
    pub fn frozen_windows(&self) -> Vec<WindowRegion> {
        self.frozen
            .lock()
            .expect("store poisoned")
            .as_ref()
            .map(|f| f.windows.clone())
            .unwrap_or_default()
    }

    /// Removes the frozen screen and returns it, if any.
    pub fn take_frozen(&self) -> Option<FrozenScreen> {
        self.remove(FROZEN_PATH);
        self.frozen.lock().expect("store poisoned").take()
    }

    /// Stores a finished capture and returns its id. Drops the oldest
    /// captures beyond [`MAX_CAPTURES`].
    pub fn add_capture(&self, png: Vec<u8>) -> u32 {
        let id = self.next_capture_id.fetch_add(1, Ordering::Relaxed) + 1;
        self.insert(capture_path(id), png);
        let dropped: Vec<u32> = {
            let mut captures = self.captures.lock().expect("store poisoned");
            captures.push(id);
            let excess = captures.len().saturating_sub(MAX_CAPTURES);
            captures.drain(..excess).collect()
        };
        for old in dropped {
            self.forget(old);
        }
        id
    }

    pub fn remove_capture(&self, id: u32) {
        self.captures
            .lock()
            .expect("store poisoned")
            .retain(|&c| c != id);
        self.forget(id);
    }

    /// Capture ids, oldest first.
    pub fn captures(&self) -> Vec<u32> {
        self.captures.lock().expect("store poisoned").clone()
    }

    pub fn set_annotations(&self, id: u32, json: String) {
        self.annotations
            .lock()
            .expect("store poisoned")
            .insert(id, json);
    }

    pub fn annotations(&self, id: u32) -> Option<String> {
        self.annotations
            .lock()
            .expect("store poisoned")
            .get(&id)
            .cloned()
    }

    fn forget(&self, id: u32) {
        self.remove(&capture_path(id));
        self.annotations.lock().expect("store poisoned").remove(&id);
    }

    pub fn get(&self, path: &str) -> Option<Arc<Vec<u8>>> {
        self.files
            .lock()
            .expect("store poisoned")
            .get(path)
            .cloned()
    }

    fn insert(&self, path: String, png: Vec<u8>) {
        self.files
            .lock()
            .expect("store poisoned")
            .insert(path, Arc::new(png));
    }

    fn remove(&self, path: &str) {
        self.files.lock().expect("store poisoned").remove(path);
    }
}

fn capture_path(id: u32) -> String {
    format!("capture-{id}.png")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn captures_get_unique_ids_and_can_be_removed() {
        let store = ImageStore::default();
        let a = store.add_capture(vec![1]);
        let b = store.add_capture(vec![2]);
        assert_ne!(a, b);
        assert_eq!(store.get(&capture_path(b)).as_deref(), Some(&vec![2]));

        store.remove_capture(a);
        assert!(store.get(&capture_path(a)).is_none());
    }

    #[test]
    fn keeps_only_the_newest_captures() {
        let store = ImageStore::default();
        let first = store.add_capture(vec![0]);
        store.set_annotations(first, "[]".into());
        let rest: Vec<u32> = (0..MAX_CAPTURES + 1)
            .map(|i| store.add_capture(vec![i as u8]))
            .collect();

        let kept = store.captures();
        assert_eq!(kept.len(), MAX_CAPTURES);
        assert_eq!(kept.first(), Some(&rest[1]));
        assert!(store.get(&capture_path(first)).is_none());
        assert!(store.annotations(first).is_none());
    }

    #[test]
    fn take_frozen_clears_the_served_png() {
        let store = ImageStore::default();
        let frozen = FrozenScreen {
            image: RgbaImage::new(2, 2),
            windows: Vec::new(),
        };
        store.set_frozen(frozen, vec![0]);
        assert!(store.get(FROZEN_PATH).is_some());

        assert!(store.take_frozen().is_some());
        assert!(store.get(FROZEN_PATH).is_none());
        assert!(store.take_frozen().is_none());
    }
}
