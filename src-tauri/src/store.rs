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

/// Full-monitor snapshot shown in the selection overlay.
pub struct FrozenScreen {
    pub image: RgbaImage,
    /// Physical pixels per logical point of the captured monitor.
    pub scale_factor: f64,
}

#[derive(Default)]
pub struct ImageStore {
    frozen: Mutex<Option<FrozenScreen>>,
    files: Mutex<HashMap<String, Arc<Vec<u8>>>>,
    next_capture_id: AtomicU32,
}

impl ImageStore {
    pub fn set_frozen(&self, frozen: FrozenScreen, png: Vec<u8>) {
        *self.frozen.lock().expect("store poisoned") = Some(frozen);
        self.insert(FROZEN_PATH.to_owned(), png);
    }

    /// Removes the frozen screen and returns it, if any.
    pub fn take_frozen(&self) -> Option<FrozenScreen> {
        self.remove(FROZEN_PATH);
        self.frozen.lock().expect("store poisoned").take()
    }

    /// Stores a finished capture and returns its id.
    pub fn add_capture(&self, png: Vec<u8>) -> u32 {
        let id = self.next_capture_id.fetch_add(1, Ordering::Relaxed) + 1;
        self.insert(capture_path(id), png);
        id
    }

    pub fn remove_capture(&self, id: u32) {
        self.remove(&capture_path(id));
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
    fn take_frozen_clears_the_served_png() {
        let store = ImageStore::default();
        let frozen = FrozenScreen {
            image: RgbaImage::new(2, 2),
            scale_factor: 2.0,
        };
        store.set_frozen(frozen, vec![0]);
        assert!(store.get(FROZEN_PATH).is_some());

        assert!(store.take_frozen().is_some());
        assert!(store.get(FROZEN_PATH).is_none());
        assert!(store.take_frozen().is_none());
    }
}
