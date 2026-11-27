// Region selection on top of the frozen screen.
//
// The frozen screenshot is shown as an <img>; the canvas above it draws the
// dimming, the selection frame, the crosshair and the size label.
// Coordinates sent to Rust are in image pixels.

import { invoke } from "@tauri-apps/api/core";
import { storedImageUrl } from "./images";

interface Point {
  x: number;
  y: number;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const DIM = "rgb(0 0 0 / 0.45)";
const FRAME = "#e53935";
const CROSSHAIR_LIGHT = "rgb(255 255 255 / 0.85)";
const CROSSHAIR_DARK = "rgb(0 0 0 / 0.55)";
const MIN_SIZE_PX = 4;

const frozen = document.querySelector<HTMLImageElement>("#frozen")!;
const canvas = document.querySelector<HTMLCanvasElement>("#overlay")!;
const ctx = canvas.getContext("2d")!;

let cursor: Point | null = null;
let anchor: Point | null = null;
let frameRequested = false;
let closing = false;

/** Image pixels per CSS pixel. */
function imageScale(): Point {
  return {
    x: frozen.naturalWidth / window.innerWidth,
    y: frozen.naturalHeight / window.innerHeight,
  };
}

/** Selection in CSS pixels, snapped to the image pixel grid. */
function selection(): Rect | null {
  if (!anchor || !cursor) return null;
  const s = imageScale();
  const snapX = (v: number) => Math.round(v * s.x) / s.x;
  const snapY = (v: number) => Math.round(v * s.y) / s.y;
  const x1 = snapX(Math.min(anchor.x, cursor.x));
  const y1 = snapY(Math.min(anchor.y, cursor.y));
  const x2 = snapX(Math.max(anchor.x, cursor.x));
  const y2 = snapY(Math.max(anchor.y, cursor.y));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

function toImagePixels(r: Rect): Rect {
  const s = imageScale();
  const x = Math.round(r.x * s.x);
  const y = Math.round(r.y * s.y);
  return {
    x,
    y,
    width: Math.min(Math.round((r.x + r.width) * s.x), frozen.naturalWidth) - x,
    height: Math.min(Math.round((r.y + r.height) * s.y), frozen.naturalHeight) - y,
  };
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  requestDraw();
}

function requestDraw() {
  if (frameRequested) return;
  frameRequested = true;
  requestAnimationFrame(() => {
    frameRequested = false;
    draw();
  });
}

function draw() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const sel = selection();
  ctx.clearRect(0, 0, w, h);

  // Dim everything except the selection.
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  if (sel) ctx.rect(sel.x, sel.y, sel.width, sel.height);
  ctx.fillStyle = DIM;
  ctx.fill("evenodd");

  if (cursor) drawCrosshair(cursor, w, h);

  if (sel && sel.width > 0 && sel.height > 0) {
    ctx.strokeStyle = FRAME;
    ctx.lineWidth = 2;
    ctx.strokeRect(sel.x - 1, sel.y - 1, sel.width + 2, sel.height + 2);
    drawSizeLabel(sel, w, h);
  }
}

function drawCrosshair(p: Point, w: number, h: number) {
  // A dark line next to a light one stays visible on any background.
  const x = Math.round(p.x) + 0.5;
  const y = Math.round(p.y) + 0.5;
  ctx.lineWidth = 1;
  for (const [color, offset] of [
    [CROSSHAIR_DARK, 1],
    [CROSSHAIR_LIGHT, 0],
  ] as const) {
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, y + offset);
    ctx.lineTo(w, y + offset);
    ctx.moveTo(x + offset, 0);
    ctx.lineTo(x + offset, h);
    ctx.stroke();
  }
}

function drawSizeLabel(sel: Rect, w: number, h: number) {
  const px = toImagePixels(sel);
  const text = `${px.width} × ${px.height}`;
  ctx.font = "12px system-ui, -apple-system, 'Segoe UI', sans-serif";
  const padX = 6;
  const boxW = ctx.measureText(text).width + 2 * padX;
  const boxH = 20;

  // Below the bottom-right corner; flip inside when there is no room.
  let x = sel.x + sel.width - boxW;
  let y = sel.y + sel.height + 6;
  if (y + boxH > h) y = sel.y + sel.height - boxH - 6;
  x = Math.max(4, Math.min(x, w - boxW - 4));

  ctx.fillStyle = "rgb(0 0 0 / 0.75)";
  ctx.beginPath();
  ctx.roundRect(x, y, boxW, boxH, 4);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + padX, y + boxH / 2);
}

async function finish() {
  const sel = selection();
  const region = sel && toImagePixels(sel);
  if (!region || region.width < MIN_SIZE_PX || region.height < MIN_SIZE_PX) {
    // Treat a click without dragging as "start over".
    anchor = null;
    requestDraw();
    return;
  }
  closing = true;
  await invoke("finish_selection", { region });
}

async function cancel() {
  if (closing) return;
  closing = true;
  await invoke("cancel_selection");
}

canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || closing) return;
  canvas.setPointerCapture(e.pointerId);
  anchor = { x: e.clientX, y: e.clientY };
  cursor = { ...anchor };
  requestDraw();
});

canvas.addEventListener("pointermove", (e) => {
  cursor = { x: e.clientX, y: e.clientY };
  requestDraw();
});

canvas.addEventListener("pointerup", (e) => {
  if (e.button !== 0 || !anchor || closing) return;
  cursor = { x: e.clientX, y: e.clientY };
  void finish();
});

canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  void cancel();
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") void cancel();
});

window.addEventListener("resize", resizeCanvas);

frozen.addEventListener("load", async () => {
  resizeCanvas();
  await invoke("overlay_ready");
});
frozen.addEventListener("error", () => void cancel());
frozen.src = storedImageUrl("frozen.png");
