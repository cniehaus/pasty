// Annotation data model. All coordinates and sizes are in image pixels.

export type Size = "s" | "m" | "l";

interface Base {
  id: string;
  x: number;
  y: number;
  color: string;
  size: Size;
}

/** Numbered step marker; (x, y) is the circle centre. */
export interface Marker extends Base {
  kind: "marker";
  label: string;
}

/** Text note; (x, y) is the top-left corner. */
export interface TextNote extends Base {
  kind: "text";
  text: string;
  boxed: boolean;
}

export type Annotation = Marker | TextNote;

export const COLORS = [
  { value: "#e53935", name: "Rot" },
  { value: "#fb8c00", name: "Orange" },
  { value: "#fdd835", name: "Gelb" },
  { value: "#43a047", name: "Grün" },
  { value: "#1e88e5", name: "Blau" },
  { value: "#212121", name: "Schwarz" },
] as const;

/** Sizes in logical points; multiplied by the image's pixel ratio. */
const MARKER_RADIUS: Record<Size, number> = { s: 11, m: 15, l: 20 };
const FONT_SIZE: Record<Size, number> = { s: 14, m: 20, l: 28 };

export function markerRadius(size: Size, pixelRatio: number): number {
  return MARKER_RADIUS[size] * pixelRatio;
}

export function fontSize(size: Size, pixelRatio: number): number {
  return FONT_SIZE[size] * pixelRatio;
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
