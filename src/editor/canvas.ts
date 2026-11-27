// Konva-based view of the screenshot and its annotations.
//
// The canvas is a pure view: it renders a list of annotations and reports
// user interaction through callbacks. All state lives in the controller.

import Konva from "konva";
import {
  type Annotation,
  type Arrow,
  type Frame,
  type HeadStyle,
  type Magnifier,
  type Marker,
  type TextNote,
  MAGNIFIER_COLOR,
  contrastColor,
  fontSize,
  markerRadius,
  strokeWidth,
} from "./model";

export const FONT_FAMILY = "system-ui, -apple-system, 'Segoe UI', sans-serif";
export const TEXT_LINE_HEIGHT = 1.2;
const SELECTION_COLOR = "#1e88e5";
/** Blur radius outside magnifiers, in logical points. */
const BLUR_RADIUS = 6;
/** Minimum drag distance (screen pixels) that counts as drawing. */
const MIN_DRAG = 6;
const HANDLE_RADIUS = 6;
/** Hit tolerance around thin strokes, in logical points. */
const HIT_TOLERANCE = 14;

export interface Point {
  x: number;
  y: number;
}

/** Builds the annotation for a drag from `start` to `end`, or null. */
export type DraftFactory = (start: Point, end: Point) => Annotation | null;

export interface CanvasCallbacks {
  /** Click on the image outside any annotation (image coordinates). */
  onBackgroundClick(point: Point): void;
  onSelect(id: string): void;
  onTranslate(id: string, dx: number, dy: number): void;
  onUpdate(id: string, change: Partial<Annotation>): void;
  onEditText(id: string): void;
  /** A drag on the background produced a new annotation. */
  onDraw(annotation: Annotation): void;
}

/** Padding inside a text box, in image pixels. */
export function textPadding(note: TextNote, pixelRatio: number): number {
  return note.boxed ? fontSize(note.size, pixelRatio) * 0.35 : 0;
}

export class AnnotationCanvas {
  readonly stage: Konva.Stage;
  /** When set, dragging on the background draws a new annotation. */
  draftFactory: DraftFactory | null = null;

  private readonly blurNode: Konva.Image;
  private readonly annotationLayer = new Konva.Layer();
  /** Selection UI and drag previews; hidden when exporting. */
  private readonly uiLayer = new Konva.Layer();
  private readonly transformer = new Konva.Transformer({
    rotateEnabled: false,
    borderStroke: SELECTION_COLOR,
    anchorStroke: SELECTION_COLOR,
    borderDash: [4, 4],
    padding: 4,
  });
  private blurred: HTMLCanvasElement | null = null;
  private drawing: { start: Point; preview: Konva.Group; draft: Annotation | null } | null = null;
  /** Set after a drag-draw so the trailing click doesn't also act. */
  private suppressClick = false;
  private scale = 1;

  constructor(
    container: HTMLDivElement,
    private readonly image: HTMLImageElement,
    readonly pixelRatio: number,
    private readonly callbacks: CanvasCallbacks,
  ) {
    this.stage = new Konva.Stage({ container, width: 1, height: 1 });

    const imageLayer = new Konva.Layer({ listening: false });
    this.blurNode = new Konva.Image({ image: undefined, visible: false });
    imageLayer.add(
      new Konva.Image({ image, width: image.naturalWidth, height: image.naturalHeight }),
      this.blurNode,
    );
    this.uiLayer.add(this.transformer);
    this.stage.add(imageLayer, this.annotationLayer, this.uiLayer);

    this.stage.on("mousedown touchstart", (e) => {
      this.suppressClick = false;
      this.startDrawing(e.target);
    });
    this.stage.on("mousemove touchmove", () => this.updateDrawing());
    // Konva fires mouseup before click, so drawing finishes first.
    this.stage.on("mouseup touchend", () => this.finishDrawing());
    window.addEventListener("pointerup", () => this.finishDrawing());

    this.stage.on("click tap", (e) => {
      if (this.suppressClick) {
        this.suppressClick = false;
        return;
      }
      if (e.evt instanceof MouseEvent && e.evt.button !== 0) return;
      if (isHandle(e.target)) return;
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
    this.uiLayer.find(".handle").forEach((n) => n.destroy());
    this.annotationLayer.destroyChildren();

    const blur = annotations.some((a) => a.kind === "magnifier" && a.blurOutside);
    if (blur) this.blurNode.image(this.blurredImage());
    this.blurNode.visible(blur);

    // Lenses at the bottom so that markers and arrows stay visible on top.
    const ordered = [
      ...annotations.filter((a) => a.kind === "magnifier"),
      ...annotations.filter((a) => a.kind !== "magnifier"),
    ];
    for (const a of ordered) {
      if (a.id === hiddenId) continue;
      const node = this.createNode(a);
      node.draggable(true);
      const origin = { x: node.x(), y: node.y() };
      node.on("dragend", () => this.callbacks.onTranslate(a.id, node.x() - origin.x, node.y() - origin.y));
      this.annotationLayer.add(node);
      if (a.id === selectedId) this.showSelection(a, node);
    }
  }

  /** Renders the annotated image at full resolution. */
  async exportPng(): Promise<Blob> {
    const { naturalWidth: w, naturalHeight: h } = this.image;
    this.uiLayer.visible(false);
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
      this.uiLayer.visible(true);
    }
  }

  // ------------------------------------------------------------- nodes ---

  private createNode(a: Annotation): Konva.Group {
    const group = new Konva.Group({ id: a.id, name: "annotation" });
    switch (a.kind) {
      case "marker":
        this.drawMarker(group, a);
        break;
      case "text":
        this.drawText(group, a);
        break;
      case "arrow":
        this.drawArrow(group, a);
        break;
      case "magnifier":
        this.drawMagnifier(group, a);
        break;
      case "frame":
        this.drawFrame(group, a);
        break;
    }
    return group;
  }

  private drawMarker(group: Konva.Group, m: Marker): void {
    group.destroyChildren();
    group.position({ x: m.x, y: m.y });
    const r = markerRadius(m.size, this.pixelRatio);

    if (m.tx !== undefined && m.ty !== undefined) {
      // Pointer in local coordinates, from the circle edge to the tip.
      const tip = { x: m.tx - m.x, y: m.ty - m.y };
      const length = Math.hypot(tip.x, tip.y);
      if (length > r) {
        const width = strokeWidth(m.size, this.pixelRatio) * 0.75;
        const angle = Math.atan2(tip.y, tip.x);
        const inset = headLength(width) * 0.8;
        group.add(
          new Konva.Line({
            points: [
              Math.cos(angle) * r,
              Math.sin(angle) * r,
              tip.x - Math.cos(angle) * inset,
              tip.y - Math.sin(angle) * inset,
            ],
            stroke: m.color,
            strokeWidth: width,
            lineCap: "round",
            hitStrokeWidth: Math.max(width, HIT_TOLERANCE * this.pixelRatio),
          }),
          arrowHead(tip.x, tip.y, angle, "filled", m.color, width),
        );
      }
    }

    group.add(
      new Konva.Circle({
        radius: r,
        fill: m.color,
        stroke: "#ffffff",
        strokeWidth: Math.max(1, r * 0.12),
        ...softShadow(r * 0.3, r * 0.06),
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
  }

  private drawText(group: Konva.Group, t: TextNote): void {
    group.position({ x: t.x, y: t.y });
    const size = fontSize(t.size, this.pixelRatio);
    const label = new Konva.Label();
    label.add(
      new Konva.Tag(
        t.boxed
          ? {
              fill: "#ffffff",
              stroke: t.color,
              strokeWidth: Math.max(1, size * 0.08),
              cornerRadius: size * 0.25,
              ...softShadow(size * 0.3, 0),
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
    group.add(label);
  }

  /** Arrow points are absolute; the group offset is the drag delta. */
  private drawArrow(group: Konva.Group, a: Arrow): void {
    group.destroyChildren();
    const width = strokeWidth(a.size, this.pixelRatio);
    const angle = Math.atan2(a.y2 - a.y, a.x2 - a.x);
    const atStart = a.heads === "start" || a.heads === "both";
    const atEnd = a.heads === "end" || a.heads === "both";

    // A filled head covers the line end; stop the line short of the tip so
    // its round cap doesn't poke through.
    const inset = a.headStyle === "filled" ? headLength(width) * 0.8 : 0;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const start = atStart ? { x: a.x + dx * inset, y: a.y + dy * inset } : { x: a.x, y: a.y };
    const end = atEnd ? { x: a.x2 - dx * inset, y: a.y2 - dy * inset } : { x: a.x2, y: a.y2 };

    group.add(
      new Konva.Line({
        points: [start.x, start.y, end.x, end.y],
        stroke: a.color,
        strokeWidth: width,
        lineCap: "round",
        hitStrokeWidth: Math.max(width, HIT_TOLERANCE * this.pixelRatio),
      }),
    );
    if (atEnd) group.add(arrowHead(a.x2, a.y2, angle, a.headStyle, a.color, width));
    if (atStart) group.add(arrowHead(a.x, a.y, angle + Math.PI, a.headStyle, a.color, width));
  }

  private drawMagnifier(group: Konva.Group, m: Magnifier): void {
    group.position({ x: m.x, y: m.y });
    const { naturalWidth: w, naturalHeight: h } = this.image;
    const ring = strokeWidth(m.size, this.pixelRatio);

    const lens = new Konva.Group({
      clipFunc: (ctx) => ctx.arc(0, 0, m.radius, 0, Math.PI * 2, false),
    });
    const zoomed = new Konva.Image({ image: this.image, width: w * m.zoom, height: h * m.zoom });
    // The lens shows the image around its current centre, also while dragging.
    const follow = () => zoomed.position({ x: -group.x() * m.zoom, y: -group.y() * m.zoom });
    follow();
    group.on("dragmove", follow);
    lens.add(zoomed);

    group.add(
      lens,
      new Konva.Circle({
        radius: m.radius,
        stroke: MAGNIFIER_COLOR,
        strokeWidth: ring,
        ...softShadow(ring * 4, ring),
        listening: false,
      }),
    );
  }

  private drawFrame(group: Konva.Group, f: Frame): void {
    group.position({ x: f.x, y: f.y });
    const width = strokeWidth(f.size, this.pixelRatio);
    // Only the outline is clickable, so markers can be placed inside.
    const common = {
      stroke: f.color,
      strokeWidth: width,
      fillEnabled: false,
      strokeScaleEnabled: false,
      hitStrokeWidth: Math.max(width, HIT_TOLERANCE * this.pixelRatio),
    };
    group.add(
      f.shape === "ellipse"
        ? new Konva.Ellipse({
            x: f.width / 2,
            y: f.height / 2,
            radiusX: f.width / 2,
            radiusY: f.height / 2,
            ...common,
          })
        : new Konva.Rect({
            width: f.width,
            height: f.height,
            cornerRadius: width,
            lineJoin: "round",
            ...common,
          }),
    );
  }

  /** Full image blurred once, shown beneath lenses with `blurOutside`. */
  private blurredImage(): HTMLCanvasElement {
    if (!this.blurred) {
      const canvas = document.createElement("canvas");
      canvas.width = this.image.naturalWidth;
      canvas.height = this.image.naturalHeight;
      const ctx = canvas.getContext("2d")!;
      // Unblurred first, so the edges don't fade to transparent.
      ctx.drawImage(this.image, 0, 0);
      ctx.filter = `blur(${BLUR_RADIUS * this.pixelRatio}px)`;
      ctx.drawImage(this.image, 0, 0);
      this.blurred = canvas;
    }
    return this.blurred;
  }

  // --------------------------------------------------------- selection ---

  private showSelection(a: Annotation, node: Konva.Group): void {
    switch (a.kind) {
      case "arrow":
        this.addArrowHandles(a, node);
        return;
      case "marker":
        this.showTransformer(node, "none");
        if (a.tx !== undefined && a.ty !== undefined) this.addPointerHandle(a, node);
        return;
      case "text":
        this.showTransformer(node, "none");
        return;
      case "magnifier":
        this.showTransformer(node, "uniform");
        node.on("transformend", () =>
          this.callbacks.onUpdate(a.id, { radius: Math.max(10, a.radius * node.scaleX()) }),
        );
        return;
      case "frame":
        this.showTransformer(node, "free");
        node.on("transformend", () =>
          this.callbacks.onUpdate(a.id, {
            x: node.x(),
            y: node.y(),
            width: Math.max(1, a.width * node.scaleX()),
            height: Math.max(1, a.height * node.scaleY()),
          }),
        );
        return;
    }
  }

  private showTransformer(node: Konva.Group, resize: "none" | "uniform" | "free"): void {
    const corners = ["top-left", "top-right", "bottom-left", "bottom-right"];
    const edges = ["top-center", "middle-right", "bottom-center", "middle-left"];
    this.transformer.setAttrs({
      resizeEnabled: resize !== "none",
      keepRatio: resize === "uniform",
      centeredScaling: resize === "uniform",
      enabledAnchors: resize === "free" ? [...corners, ...edges] : resize === "uniform" ? corners : [],
    });
    this.transformer.nodes([node]);
  }

  private addArrowHandles(a: Arrow, group: Konva.Group): void {
    let live: Arrow = { ...a };
    this.addHandle(group, { x: a.x, y: a.y }, (p) => {
      live = { ...live, x: p.x, y: p.y };
      this.drawArrow(group, live);
      return { x: p.x, y: p.y };
    });
    this.addHandle(group, { x: a.x2, y: a.y2 }, (p) => {
      live = { ...live, x2: p.x, y2: p.y };
      this.drawArrow(group, live);
      return { x2: p.x, y2: p.y };
    });
  }

  private addPointerHandle(m: Marker, group: Konva.Group): void {
    this.addHandle(group, { x: m.tx!, y: m.ty! }, (p) => {
      this.drawMarker(group, { ...m, tx: p.x, ty: p.y });
      return { tx: p.x, ty: p.y };
    });
  }

  /**
   * Draggable handle at `at`. `onMove` redraws live and returns the change
   * committed on release. Handles follow when the whole node is dragged.
   */
  private addHandle(
    group: Konva.Group,
    at: Point,
    onMove: (p: Point) => Partial<Annotation>,
  ): void {
    const id = group.id();
    const handle = new Konva.Circle({
      name: "handle",
      ...at,
      radius: HANDLE_RADIUS / this.scale,
      fill: "#ffffff",
      stroke: SELECTION_COLOR,
      strokeWidth: 2 / this.scale,
      draggable: true,
    });
    let change: Partial<Annotation> = {};
    handle.on("dragmove", () => {
      change = onMove(handle.position());
    });
    handle.on("dragend", () => this.callbacks.onUpdate(id, change));
    this.uiLayer.add(handle);

    const origin = { x: group.x(), y: group.y() };
    group.on("dragmove", () =>
      handle.position({ x: at.x + group.x() - origin.x, y: at.y + group.y() - origin.y }),
    );
  }

  // ---------------------------------------------------- drag-to-create ---

  private startDrawing(target: Konva.Node): void {
    if (!this.draftFactory || annotationId(target) || isHandle(target)) return;
    const start = this.stage.getRelativePointerPosition();
    if (!start) return;
    const preview = new Konva.Group({ listening: false });
    this.uiLayer.add(preview);
    this.drawing = { start, preview, draft: null };
  }

  private updateDrawing(): void {
    if (!this.drawing || !this.draftFactory) return;
    const end = this.stage.getRelativePointerPosition();
    if (!end) return;
    const { start, preview } = this.drawing;
    preview.destroyChildren();
    this.drawing.draft = null;
    if (Math.hypot(end.x - start.x, end.y - start.y) * this.scale < MIN_DRAG) return;

    const draft = this.draftFactory(start, end);
    if (draft) {
      this.drawing.draft = draft;
      preview.add(this.createNode(draft));
    }
  }

  private finishDrawing(): void {
    if (!this.drawing) return;
    const { preview, draft } = this.drawing;
    this.drawing = null;
    preview.destroy();
    if (draft) {
      this.suppressClick = true;
      this.callbacks.onDraw(draft);
    }
  }
}

function annotationId(target: Konva.Node): string | null {
  const node = target.findAncestor(".annotation", true);
  return node ? node.id() : null;
}

function isHandle(target: Konva.Node): boolean {
  return target.hasName("handle");
}

function headLength(lineWidth: number): number {
  return lineWidth * 4;
}

function arrowHead(
  x: number,
  y: number,
  angle: number,
  style: HeadStyle,
  color: string,
  width: number,
): Konva.Shape {
  if (style === "dot") {
    return new Konva.Circle({ x, y, radius: width * 1.6, fill: color });
  }
  const length = headLength(width);
  const half = width * 2.2;
  const bx = x - Math.cos(angle) * length;
  const by = y - Math.sin(angle) * length;
  const px = -Math.sin(angle) * half;
  const py = Math.cos(angle) * half;
  const wing = [bx + px, by + py, x, y, bx - px, by - py];

  return style === "filled"
    ? new Konva.Line({
        points: wing,
        closed: true,
        fill: color,
        stroke: color,
        strokeWidth: width * 0.5,
        lineJoin: "round",
      })
    : new Konva.Line({
        points: wing,
        stroke: color,
        strokeWidth: width,
        lineCap: "round",
        lineJoin: "round",
      });
}

/**
 * Shadow settings. `perfectDrawEnabled: false` avoids square artefacts:
 * fill + stroke + shadow otherwise goes through a clipped buffer canvas.
 */
function softShadow(blur: number, offsetY: number): Konva.ShapeConfig {
  return {
    shadowColor: "#000000",
    shadowBlur: blur,
    shadowOpacity: 0.35,
    shadowOffset: { x: 0, y: offsetY },
    perfectDrawEnabled: false,
  };
}
