// Konva-based view of the screenshot and its annotations.
//
// The canvas is a pure view: it renders a list of annotations and reports
// user interaction through callbacks. All state lives in the controller.

import Konva from "konva";
import {
  type Annotation,
  type Marker,
  type TextNote,
  contrastColor,
  fontSize,
  markerRadius,
} from "./model";

export const FONT_FAMILY = "system-ui, -apple-system, 'Segoe UI', sans-serif";
export const TEXT_LINE_HEIGHT = 1.2;
const SELECTION_COLOR = "#1e88e5";

export interface Point {
  x: number;
  y: number;
}

export interface CanvasCallbacks {
  /** Click on the image outside any annotation (image coordinates). */
  onBackgroundClick(point: Point): void;
  onSelect(id: string): void;
  onMove(id: string, x: number, y: number): void;
  onEditText(id: string): void;
}

/** Padding inside a text box, in image pixels. */
export function textPadding(note: TextNote, pixelRatio: number): number {
  return note.boxed ? fontSize(note.size, pixelRatio) * 0.35 : 0;
}

export class AnnotationCanvas {
  readonly stage: Konva.Stage;
  private readonly annotationLayer = new Konva.Layer();
  private readonly transformer = new Konva.Transformer({
    resizeEnabled: false,
    rotateEnabled: false,
    borderStroke: SELECTION_COLOR,
    borderDash: [4, 4],
    padding: 4,
  });
  private scale = 1;

  constructor(
    container: HTMLDivElement,
    private readonly image: HTMLImageElement,
    readonly pixelRatio: number,
    private readonly callbacks: CanvasCallbacks,
  ) {
    this.stage = new Konva.Stage({ container, width: 1, height: 1 });

    const imageLayer = new Konva.Layer({ listening: false });
    imageLayer.add(
      new Konva.Image({ image, width: image.naturalWidth, height: image.naturalHeight }),
    );
    this.stage.add(imageLayer, this.annotationLayer);

    this.stage.on("click tap", (e) => {
      if (e.evt instanceof MouseEvent && e.evt.button !== 0) return;
      const id = annotationId(e.target);
      if (id) {
        callbacks.onSelect(id);
      } else {
        const p = this.stage.getRelativePointerPosition();
        if (p) callbacks.onBackgroundClick(p);
      }
    });
    this.stage.on("dblclick dbltap", (e) => {
      const id = annotationId(e.target);
      if (id) callbacks.onEditText(id);
    });
  }

  /** Display scale: CSS pixels per image pixel. */
  get viewScale(): number {
    return this.scale;
  }

  /** Shows the image at 100 % (logical size) or smaller to fit. */
  fit(availableWidth: number, availableHeight: number): void {
    const { naturalWidth: w, naturalHeight: h } = this.image;
    this.scale = Math.min(1 / this.pixelRatio, availableWidth / w, availableHeight / h);
    this.stage.size({ width: w * this.scale, height: h * this.scale });
    this.stage.scale({ x: this.scale, y: this.scale });
  }

  render(annotations: readonly Annotation[], selectedId: string | null, hiddenId?: string): void {
    this.transformer.nodes([]);
    this.annotationLayer.destroyChildren();

    for (const a of annotations) {
      if (a.id === hiddenId) continue;
      const node = a.kind === "marker" ? this.markerNode(a) : this.textNode(a);
      node.on("dragend", () => this.callbacks.onMove(a.id, node.x(), node.y()));
      this.annotationLayer.add(node);
      if (a.id === selectedId) this.transformer.nodes([node]);
    }
    this.annotationLayer.add(this.transformer);
  }

  /** Renders the annotated image at full resolution. */
  async exportPng(): Promise<Blob> {
    const { naturalWidth: w, naturalHeight: h } = this.image;
    const selected = this.transformer.nodes();
    this.transformer.nodes([]);
    this.stage.scale({ x: 1, y: 1 });
    this.stage.size({ width: w, height: h });
    try {
      const canvas = this.stage.toCanvas({ pixelRatio: 1 });
      return await new Promise((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("export failed"))), "image/png"),
      );
    } finally {
      this.stage.scale({ x: this.scale, y: this.scale });
      this.stage.size({ width: w * this.scale, height: h * this.scale });
      this.transformer.nodes(selected);
    }
  }

  private markerNode(m: Marker): Konva.Group {
    const r = markerRadius(m.size, this.pixelRatio);
    const group = new Konva.Group({ id: m.id, name: "annotation", x: m.x, y: m.y, draggable: true });
    group.add(
      new Konva.Circle({
        radius: r,
        fill: m.color,
        stroke: "#ffffff",
        strokeWidth: Math.max(1, r * 0.12),
        shadowColor: "#000000",
        shadowBlur: r * 0.3,
        shadowOpacity: 0.35,
        shadowOffset: { x: 0, y: r * 0.06 },
        // Fill + stroke + shadow otherwise goes through a clipped buffer
        // canvas, leaving square shadow artefacts.
        perfectDrawEnabled: false,
      }),
      new Konva.Text({
        text: m.label,
        x: -r,
        y: -r,
        width: 2 * r,
        height: 2 * r,
        align: "center",
        verticalAlign: "middle",
        fontSize: r * 1.15,
        fontStyle: "bold",
        fontFamily: FONT_FAMILY,
        fill: contrastColor(m.color),
        listening: false,
      }),
    );
    return group;
  }

  private textNode(t: TextNote): Konva.Label {
    const size = fontSize(t.size, this.pixelRatio);
    const label = new Konva.Label({ id: t.id, name: "annotation", x: t.x, y: t.y, draggable: true });
    label.add(
      new Konva.Tag(
        t.boxed
          ? {
              fill: "#ffffff",
              stroke: t.color,
              strokeWidth: Math.max(1, size * 0.08),
              cornerRadius: size * 0.25,
              shadowColor: "#000000",
              shadowBlur: size * 0.3,
              shadowOpacity: 0.25,
              perfectDrawEnabled: false,
            }
          : {},
      ),
      new Konva.Text({
        text: t.text,
        fontSize: size,
        fontFamily: FONT_FAMILY,
        lineHeight: TEXT_LINE_HEIGHT,
        fill: t.color,
        padding: textPadding(t, this.pixelRatio),
      }),
    );
    return label;
  }
}

function annotationId(target: Konva.Node): string | null {
  const node = target.findAncestor(".annotation", true);
  return node ? node.id() : null;
}
