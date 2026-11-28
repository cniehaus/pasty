// Annotation data model. All coordinates and sizes are in image pixels.

export type Size = "s" | "m" | "l" | "xl";
export type HeadStyle = "filled" | "open" | "dot";
/** Text background: none, white outline around letters, white box, box in the text colour. */
export type TextBackground = "none" | "halo" | "white" | "color";
/** Arrow end: no head (plain line end) or a head style. */
export type Head = "none" | HeadStyle;
export type FrameShape = "rect" | "ellipse";
export type RedactMode = "pixelate" | "blur" | "solid";
/** Sequence for new markers: 1, 2, 3 … or A, B, C … */
export type MarkerKind = "number" | "letter";

/** Current tool settings; each annotation kind uses a subset. */
export interface Style {
  color: string;
  size: Size;
  textBackground: TextBackground;
  /** Font size of text in points (logical pixels). */
  textSize: number;
  bold: boolean;
  italic: boolean;
  startHead: Head;
  endHead: Head;
  zoom: number;
  blurOutside: boolean;
  shape: FrameShape;
  redactMode: RedactMode;
  markerKind: MarkerKind;
  highlightColor: string;
}

interface Base {
  id: string;
  x: number;
  y: number;
  color: string;
  size: Size;
}

/**
 * Numbered step marker; (x, y) is the circle centre. With a pointer, a line
 * runs from the circle to the tip (tx, ty).
 */
export interface Marker extends Base {
  kind: "marker";
  label: string;
  tx?: number;
  ty?: number;
}

/** Text note; (x, y) is the top-left corner. */
export interface TextNote extends Base {
  kind: "text";
  text: string;
  textBackground: TextBackground;
  /** Font size in points (logical pixels); replaces `size` for texts. */
  textSize: number;
  bold: boolean;
  italic: boolean;
}

/** Arrow or line from (x, y) to (x2, y2). */
export interface Arrow extends Base {
  kind: "arrow";
  x2: number;
  y2: number;
  startHead: Head;
  endHead: Head;
}

/** Circular lens magnifying what lies beneath its centre (x, y). */
export interface Magnifier extends Base {
  kind: "magnifier";
  radius: number;
  zoom: number;
  blurOutside: boolean;
}

/** Outline for circling something; (x, y) is the top-left corner. */
export interface Frame extends Base {
  kind: "frame";
  width: number;
  height: number;
  shape: FrameShape;
}

/** Area made unreadable; (x, y) is the top-left corner. */
export interface Redaction extends Base {
  kind: "redact";
  width: number;
  height: number;
  redactMode: RedactMode;
}

/** Area that stays bright while everything else is dimmed. */
export interface Spotlight extends Base {
  kind: "spotlight";
  width: number;
  height: number;
  shape: FrameShape;
}

/**
 * Visible part of the image. Not drawn; at most one per document. Kept in
 * the annotation list so it shares undo, saving and restoring.
 */
export interface Crop extends Base {
  kind: "crop";
  width: number;
  height: number;
}

/** Highlighter stroke over an area; drawn with "multiply" so text stays dark. */
export interface Highlight extends Base {
  kind: "highlight";
  width: number;
  height: number;
  highlightColor: string;
}

export type Annotation = Marker | TextNote | Arrow | Magnifier | Frame | Redaction | Spotlight | Crop | Highlight;
/** Annotations described by a rectangle (x, y, width, height). */
export type BoxAnnotation = Frame | Redaction | Spotlight | Highlight;
/** Kinds covering an area; other tools draw over them instead of grabbing them. */
export const AREA_KINDS: readonly Kind[] = ["redact", "magnifier", "highlight"];
export type Kind = Annotation["kind"];

/** Style properties that apply to each kind. */
export const STYLE_KEYS: Record<Kind, readonly (keyof Style)[]> = {
  marker: ["color", "size"],
  text: ["color", "textSize", "textBackground", "bold", "italic"],
  arrow: ["color", "size", "startHead", "endHead"],
  magnifier: ["size", "zoom", "blurOutside"],
  frame: ["color", "size", "shape"],
  redact: ["color", "size", "redactMode"],
  spotlight: ["size", "shape"],
  crop: [],
  highlight: ["highlightColor"],
};

export const HIGHLIGHT_COLORS = [
  { value: "#ffeb3b", name: "Gelb" },
  { value: "#b2f28c", name: "Grün" },
  { value: "#ffa8dc", name: "Pink" },
  { value: "#ffc46b", name: "Orange" },
  { value: "#9fd8ff", name: "Blau" },
] as const;

/** Aspect ratios offered when cropping; null = free. */
export const CROP_RATIOS: readonly { label: string; ratio: number | "original" | null }[] = [
  { label: "Frei", ratio: null },
  { label: "Original", ratio: "original" },
  { label: "1:1", ratio: 1 },
  { label: "4:3", ratio: 4 / 3 },
  { label: "16:9", ratio: 16 / 9 },
];

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function cropOf(annotations: readonly Annotation[]): Crop | undefined {
  return annotations.find((a): a is Crop => a.kind === "crop");
}

/**
 * Largest rectangle with the given aspect ratio, centred on `around` and
 * kept inside `bounds`.
 */
export function fitRatio(around: Rect, ratio: number, bounds: Rect): Rect {
  let width = around.width;
  let height = width / ratio;
  if (height > around.height) {
    height = around.height;
    width = height * ratio;
  }
  width = Math.min(width, bounds.width, bounds.height * ratio);
  height = width / ratio;
  const cx = around.x + around.width / 2;
  const cy = around.y + around.height / 2;
  const x = Math.min(Math.max(bounds.x, cx - width / 2), bounds.x + bounds.width - width);
  const y = Math.min(Math.max(bounds.y, cy - height / 2), bounds.y + bounds.height - height);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

export const COLORS = [
  { value: "#e53935", name: "Rot" },
  { value: "#fb8c00", name: "Orange" },
  { value: "#fdd835", name: "Gelb" },
  { value: "#43a047", name: "Grün" },
  { value: "#1e88e5", name: "Blau" },
  { value: "#212121", name: "Schwarz" },
] as const;

export const ZOOM_LEVELS = [1.5, 2, 3] as const;

export const DEFAULT_STYLE: Style = {
  color: COLORS[0].value,
  size: "m",
  textBackground: "white",
  textSize: 20,
  bold: false,
  italic: false,
  startHead: "none",
  endHead: "filled",
  zoom: 2,
  blurOutside: false,
  shape: "rect",
  redactMode: "pixelate",
  markerKind: "number",
  highlightColor: "#ffeb3b",
};

export const MAGNIFIER_COLOR = "#ffffff";

// Sizes in logical points; multiplied by the image's pixel ratio.
const MARKER_RADIUS: Record<Size, number> = { s: 11, m: 15, l: 20, xl: 28 };
const FONT_SIZE: Record<Size, number> = { s: 14, m: 20, l: 28, xl: 40 };
const STROKE_WIDTH: Record<Size, number> = { s: 2.5, m: 4, l: 6, xl: 11 };
const MAGNIFIER_RADIUS = 90;
const PIXEL_BLOCK: Record<Size, number> = { s: 6, m: 10, l: 16, xl: 24 };
// Light enough that one still sees there was text, too strong to read it.
const REDACT_BLUR: Record<Size, number> = { s: 2, m: 3.5, l: 6, xl: 10 };
const DIM_OPACITY: Record<Size, number> = { s: 0.35, m: 0.55, l: 0.75, xl: 0.85 };

export function markerRadius(size: Size, pixelRatio: number): number {
  return MARKER_RADIUS[size] * pixelRatio;
}

export function fontSize(size: Size, pixelRatio: number): number {
  return FONT_SIZE[size] * pixelRatio;
}

export const TEXT_SIZE_RANGE = { min: 8, max: 120 } as const;

/** Font size of a text note in image pixels. */
export function textFontSize(note: TextNote, pixelRatio: number): number {
  return (note.textSize ?? FONT_SIZE[note.size]) * pixelRatio;
}

/** Next font size up or down, in steps that feel even at any size. */
export function stepTextSize(current: number, direction: 1 | -1): number {
  const step = current < 16 ? 1 : current < 40 ? 2 : 4;
  const next = current + direction * step;
  return Math.min(TEXT_SIZE_RANGE.max, Math.max(TEXT_SIZE_RANGE.min, next));
}

export function strokeWidth(size: Size, pixelRatio: number): number {
  return STROKE_WIDTH[size] * pixelRatio;
}

export function defaultMagnifierRadius(pixelRatio: number): number {
  return MAGNIFIER_RADIUS * pixelRatio;
}

export function pixelBlockSize(size: Size, pixelRatio: number): number {
  return Math.max(2, Math.round(PIXEL_BLOCK[size] * pixelRatio));
}

export function redactBlurRadius(size: Size, pixelRatio: number): number {
  return REDACT_BLUR[size] * pixelRatio;
}

export function dimOpacity(size: Size): number {
  return DIM_OPACITY[size];
}

/** Copies the style properties relevant for `kind`. */
export function styleFor(kind: Kind, style: Partial<Style>): Partial<Style> {
  const result: Partial<Style> = {};
  for (const key of STYLE_KEYS[kind]) {
    if (style[key] !== undefined) (result as Record<string, unknown>)[key] = style[key];
  }
  return result;
}

export function translate(a: Annotation, dx: number, dy: number): Annotation {
  const moved = { ...a, x: a.x + dx, y: a.y + dy };
  if (moved.kind === "arrow") return { ...moved, x2: moved.x2 + dx, y2: moved.y2 + dy };
  if (moved.kind === "marker" && moved.tx !== undefined && moved.ty !== undefined) {
    return { ...moved, tx: moved.tx + dx, ty: moved.ty + dy };
  }
  return moved;
}

/**
 * Brings annotations saved by older versions up to date (arrows used to
 * have `heads` + `headStyle` instead of one head per end; texts had a
 * `boxed` flag instead of a background choice).
 */
export function migrate(saved: unknown[]): Annotation[] {
  return saved.map((item) => {
    const a = item as Record<string, unknown>;
    if (a.kind === "text") {
      let note = { ...a };
      if ("boxed" in note) {
        const { boxed, ...rest } = note as { boxed: boolean };
        note = { ...rest, textBackground: boxed ? "white" : "none", bold: false, italic: false };
      }
      if (note.textSize === undefined) note.textSize = FONT_SIZE[(note.size as Size) ?? "m"];
      return note as unknown as Annotation;
    }
    if (a.kind === "arrow" && "heads" in a) {
      const { heads, headStyle, ...rest } = a as { heads: string; headStyle: HeadStyle };
      const style = headStyle ?? "filled";
      return {
        ...rest,
        startHead: heads === "start" || heads === "both" ? style : "none",
        endHead: heads === "end" || heads === "both" ? style : "none",
      } as Annotation;
    }
    return a as unknown as Annotation;
  });
}

/** Rectangle spanned by two corner points. */
export function spanRect(a: { x: number; y: number }, b: { x: number; y: number }) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

/**
 * Next marker label: one after the highest existing one of the same kind.
 * Numbers and letters count independently; letters run A–Z, then wrap to A.
 */
export function nextMarkerLabel(annotations: readonly Annotation[], kind: MarkerKind = "number"): string {
  const labels = annotations.filter((a): a is Marker => a.kind === "marker").map((m) => m.label);
  if (kind === "letter") {
    const codes = labels.filter((l) => /^[A-Z]$/.test(l)).map((l) => l.charCodeAt(0) - 65);
    const next = codes.length ? (Math.max(...codes) + 1) % 26 : 0;
    return String.fromCharCode(65 + next);
  }
  const numbers = labels.filter((l) => /^\d+$/.test(l)).map((l) => Number.parseInt(l, 10));
  return String(Math.max(0, ...numbers) + 1);
}

/** Readable text colour on top of `color` (hex #rrggbb). */
export function contrastColor(color: string): string {
  const r = Number.parseInt(color.slice(1, 3), 16);
  const g = Number.parseInt(color.slice(3, 5), 16);
  const b = Number.parseInt(color.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#212121" : "#ffffff";
}

let idCounter = 0;
/** Unique within the session, also next to annotations restored from Rust. */
export function newId(): string {
  idCounter += 1;
  return `a${Date.now().toString(36)}${idCounter}`;
}
