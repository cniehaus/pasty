// Placeholder editor: shows the captured region.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { storedImageUrl } from "./images";

const id = getCurrentWindow().label.replace(/^editor-/, "");
const img = document.querySelector<HTMLImageElement>("#capture")!;
img.src = storedImageUrl(`capture-${id}.png`);

// The image is stored at physical resolution; show it at 100 % (logical size).
img.addEventListener("load", () => {
  img.style.width = `${img.naturalWidth / window.devicePixelRatio}px`;
});
