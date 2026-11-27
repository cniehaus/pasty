import { convertFileSrc } from "@tauri-apps/api/core";

/** URL of an image held in Pasta's in-memory store (see `store.rs`). */
export function storedImageUrl(path: string): string {
  return `${convertFileSrc(path, "pasta")}?t=${Date.now()}`;
}

// Note: `convertFileSrc` percent-encodes the whole path, so stored image
// names must not contain "/".
