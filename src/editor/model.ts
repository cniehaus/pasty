// Annotation data model. All coordinates and sizes are in image pixels.

export type Size = "s" | "m" | "l";
export type HeadPosition = "end" | "start" | "both" | "none";
export type HeadStyle = "filled" | "open" | "dot";
export type FrameShape = "rect" | "ellipse";

/** Current tool settings; each annotation kind uses a subset. */
export interface Style {
  color: string;
  size: Size;
  boxed: boolean;
  heads: HeadPosition;
  headStyle: HeadStyle;
  zoom: number;
  blurOutside: boolean;
  shape: FrameShape;
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
  boxed: boolean;
}

/** Arrow or line from (x, y) to (x2, y2). */
export interface Arrow extends Base {
  kind: "arrow";
  x2: number;
  y2: number;
  heads: HeadPosition;
  headStyle: HeadStyle;
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

export type Annotation = Marker | TextNote | Arrow | Magnifier | Frame;
export type Kind = Annotation["kind"];

/** Style properties that apply to each kind. */
export const STYLE_KEYS: Record<Kind, readonly (keyof Style)[]> = {
  marker: ["color", "size"],
  text: ["color", "size", "boxed"],
  arrow: ["color", "size", "heads", "headStyle"],
  magnifier: ["size", "zoom", "blurOutside"],
  frame: ["color", "size", "shape"],
};

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
  boxed: false,
  heads: "end",
  headStyle: "filled",
  zoom: 2,
  blurOutside: false,
  shape: "rect",
};

export const MAGNIFIER_COLOR = "#ffffff";

// Sizes in logical points; multiplied by the image's pixel ratio.
const MARKER_RADIUS: Record<Size, number> = { s: 11, m: 15, l: 20 };
const FONT_SIZE: Record<Size, number> = { s: 14, m: 20, l: 28 };
const STROKE_WIDTH: Record<Size, number> = { s: 2.5, m: 4, l: 6 };
const MAGNIFIER_RADIUS = 90;

export function markerRadius(size: Size, pixelRatio: number): number {
  return MARKER_RADIUS[size] * pixelRatio;
}

export function fontSize(size: Size, pixelRatio: number): number {
  return FONT_SIZE[size] * pixelRatio;
}

export function strokeWidth(size: Size, pixelRatio: number): number {
  return STROKE_WIDTH[size] * pixelRatio;
}

export function defaultMagnifierRadius(pixelRatio: number): number {
  return MAGNIFIER_RADIUS * pixelRatio;
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

/** Rectangle spanned by two corner points. */
export function spanRect(a: { x: number; y: number }, b: { x: number; y: number }) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

/** Next step number: one more than the highest existing marker. */
export function nextMarkerLabel(annotations: readonly Annotation[]): string {
  const numbers = annotations
    .filter((a): a is Marker => a.kind === "marker")
    .map((m) => Number.parseInt(m.label, 10))
    .filter(Number.isFinite);
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
export function newId(): string {
  idCounter += 1;
  return `a${idCounter}`;
}
