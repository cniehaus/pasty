// Konva-based view of the screenshot and its annotations.
//
// The canvas is a pure view: it renders a list of annotations and reports
// user interaction through callbacks. All state lives in the controller.

import Konva from "konva";
import {
  type Annotation,
  type Arrow,
  type BoxAnnotation,
  type Frame,
  type Highlight,
  type FrameShape,
  type HeadStyle,
  type Magnifier,
  type Marker,
  type Rect,
  type Redaction,
  type Spotlight,
  type TextNote,
  AREA_KINDS,
  MAGNIFIER_COLOR,
  contrastColor,
  cropOf,
  dimOpacity,
  markerRadius,
  pixelBlockSize,
  redactBlurRadius,
  strokeWidth,
  textFontSize,
} from "./model";

export const FONT_FAMILY = "system-ui, -apple-system, 'Segoe UI', sans-serif";
export const TEXT_LINE_HEIGHT = 1.2;
const SELECTION_COLOR = "#1e88e5";
/** Blur radius outside magnifiers, in logical points. */
const BLUR_RADIUS = 6;
/** Minimum drag distance (screen pixels) that counts as drawing. */
const MIN_DRAG = 6;
const HANDLE_RADIUS = 6;
/** Room around the image while cropping, so edge anchors aren't clipped. */
const CROP_MARGIN = 14;
/** Smallest crop that a drag creates, in image pixels. */
const MIN_CROP = 8;
/** Hit tolerance around thin strokes, in screen pixels. */
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

/** Konva font style for a text note, e.g. "italic bold". */
export function textFontStyle(note: TextNote): string {
  return [note.italic ? "italic" : "", note.bold ? "bold" : ""].filter(Boolean).join(" ") || "normal";
}

/** Padding inside a text box, in image pixels. */
export function textPadding(note: TextNote, pixelRatio: number): number {
  const boxed = note.textBackground === "white" || note.textBackground === "color";
  return boxed ? textFontSize(note, pixelRatio) * 0.35 : 0;
}

export class AnnotationCanvas {
  readonly stage: Konva.Stage;
  /** When set, dragging on the background draws a new annotation. */
  draftFactory: DraftFactory | null = null;
  /**
   * Active tool. With "select", frames and spotlights can be grabbed
   * anywhere inside; with other tools only at the outline, so the inside
   * stays free for placing markers or text.
   */
  tool = "select";

  private readonly blurNode: Konva.Image;
  /** Image, blurred copy and highlighter strokes share one layer, so the
   *  highlighter can multiply with the image pixels. */
  private readonly baseLayer = new Konva.Layer();
  private readonly highlightGroup = new Konva.Group();
  /** Redactions sit directly on the image, below everything else. */
  private readonly redactLayer = new Konva.Layer();
  /** Dimming around spotlights. */
  private readonly dimLayer = new Konva.Layer({ listening: false });
  private readonly dimShape: Konva.Shape;
  private spotlights: { node: Konva.Group; spot: Spotlight }[] = [];
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
  /** Derived images, keyed by what they depend on. */
  private readonly cache = new Map<string, HTMLCanvasElement>();
  /** Image with all redactions applied; source for lenses and blur. */
  private base: { key: string; canvas: HTMLCanvasElement } | null = null;
  private drawing: { start: Point; preview: Konva.Group; draft: Annotation | null } | null = null;
  /** Set after a drag-draw so the trailing click doesn't also act. */
  private suppressClick = false;
  private scale = 1;
  /** Space the stage may use, from the last `fit` call. */
  private available = { width: 1, height: 1 };
  /** Part of the image shown and exported (the crop, or all of it). */
  private region: Rect;
  /** Interactive crop frame while the crop tool is active. */
  private cropUi: {
    group: Konva.Group;
    rect: Konva.Rect;
    transformer: Konva.Transformer;
    /** Locked aspect ratio (width / height), or null. */
    ratio: number | null;
  } | null = null;

  constructor(
    container: HTMLDivElement,
    private readonly image: HTMLImageElement,
    readonly pixelRatio: number,
    private readonly callbacks: CanvasCallbacks,
  ) {
    this.stage = new Konva.Stage({ container, width: 1, height: 1 });
    this.region = { x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight };

    this.blurNode = new Konva.Image({ image: undefined, visible: false, listening: false });
    this.baseLayer.add(
      new Konva.Image({ image, width: image.naturalWidth, height: image.naturalHeight, listening: false }),
      this.blurNode,
      this.highlightGroup,
    );
    this.dimShape = new Konva.Shape({
      sceneFunc: (ctx) => this.drawDimming(ctx._context),
      visible: false,
    });
    this.dimLayer.add(this.dimShape);
    this.uiLayer.add(this.transformer);
    this.stage.add(this.baseLayer, this.redactLayer, this.dimLayer, this.annotationLayer, this.uiLayer);

    this.stage.on("mousedown touchstart", (e) => {
      this.suppressClick = false;
      this.startDrawing(e.target);
    });
    this.stage.on("mousemove touchmove", () => this.updateDrawing());
    // Konva fires mouseup before click, so drawing finishes first.
    this.stage.on("mouseup touchend", () => this.finishDrawing());
    window.addEventListener("pointerup", this.onWindowPointerUp);

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

  private readonly onWindowPointerUp = () => this.finishDrawing();

  /** Releases the stage and global listeners (when switching images). */
  destroy(): void {
    window.removeEventListener("pointerup", this.onWindowPointerUp);
    this.stage.destroy();
  }

  /** Small PNG data URL of the annotated image for the film strip. */
  thumbnail(maxWidth: number, maxHeight: number): string {
    const { width: w, height: h } = this.shown();
    const ratio = Math.min(maxWidth / w, maxHeight / h, 1) / this.scale;
    this.uiLayer.visible(false);
    try {
      return this.stage.toDataURL({ pixelRatio: ratio });
    } finally {
      this.uiLayer.visible(true);
    }
  }

  /** Display scale: CSS pixels per image pixel. */
  get viewScale(): number {
    return this.scale;
  }

  /** Top-left of the visible part in image pixels (for screen mapping). */
  get viewOrigin(): { x: number; y: number } {
    const r = this.shown();
    return { x: r.x, y: r.y };
  }

  /** Size of the exported image (the crop, or the whole image). */
  get outputSize(): { width: number; height: number } {
    return { width: this.region.width, height: this.region.height };
  }

  /** Shows the visible part at 100 % (logical size) or smaller to fit. */
  fit(availableWidth: number, availableHeight: number): void {
    this.available = { width: availableWidth, height: availableHeight };
    this.applyFit();
  }

  private fullImage(): Rect {
    return { x: 0, y: 0, width: this.image.naturalWidth, height: this.image.naturalHeight };
  }

  /** While cropping the whole image is shown, otherwise the crop. */
  private shown(): Rect {
    return this.cropUi ? this.fullImage() : this.region;
  }

  private applyFit(): void {
    const r = this.shown();
    const m = this.cropUi ? CROP_MARGIN : 0;
    this.scale = Math.min(
      1 / this.pixelRatio,
      (this.available.width - 2 * m) / r.width,
      (this.available.height - 2 * m) / r.height,
    );
    this.stage.size({ width: r.width * this.scale + 2 * m, height: r.height * this.scale + 2 * m });
    this.stage.scale({ x: this.scale, y: this.scale });
    this.stage.position({ x: m - r.x * this.scale, y: m - r.y * this.scale });
  }

  render(annotations: readonly Annotation[], selectedId: string | null, hiddenId?: string): void {
    this.transformer.nodes([]);
    this.uiLayer.find(".handle").forEach((n) => n.destroy());
    // Nodes are recreated, so a pending mouseleave would never fire.
    this.stage.container().style.cursor = "";
    this.redactLayer.destroyChildren();
    this.highlightGroup.destroyChildren();
    this.annotationLayer.destroyChildren();
    this.spotlights = [];

    const crop = cropOf(annotations);
    const region = crop ? { x: crop.x, y: crop.y, width: crop.width, height: crop.height } : this.fullImage();
    if (JSON.stringify(region) !== JSON.stringify(this.region)) {
      this.region = region;
      this.applyFit();
    }

    this.updateBase(annotations.filter((a): a is Redaction => a.kind === "redact"));
    const blur = annotations.some((a) => a.kind === "magnifier" && a.blurOutside);
    if (blur) this.blurNode.image(this.blurredBase());
    this.blurNode.visible(blur);

    // Lenses at the bottom so that markers and arrows stay visible on top.
    const ordered = [
      ...annotations.filter((a) => a.kind === "magnifier"),
      ...annotations.filter((a) => a.kind !== "magnifier"),
    ];
    for (const a of ordered) {
      if (a.id === hiddenId || a.kind === "crop") continue;
      const node = this.createNode(a);
      node.draggable(true);
      // Show where things can be grabbed.
      node.on("mouseenter", () => (this.stage.container().style.cursor = "move"));
      node.on("mouseleave", () => (this.stage.container().style.cursor = ""));
      const origin = { x: node.x(), y: node.y() };
      node.on("dragend", () => this.callbacks.onTranslate(a.id, node.x() - origin.x, node.y() - origin.y));
      // Areas don't catch clicks of other tools, so one can draw over them.
      if (AREA_KINDS.includes(a.kind)) node.listening(this.tool === "select" || this.tool === a.kind);
      const target =
        a.kind === "highlight" ? this.highlightGroup : a.kind === "redact" ? this.redactLayer : this.annotationLayer;
      target.add(node);
      if (a.kind === "spotlight") {
        this.spotlights.push({ node, spot: a });
        node.on("dragmove transform", () => this.dimLayer.batchDraw());
      }
      if (a.id === selectedId) this.showSelection(a, node);
    }
    this.dimShape.visible(this.spotlights.length > 0);
    this.dimLayer.batchDraw();
  }

  /** Renders the annotated image at full resolution. */
  async exportPng(): Promise<Blob> {
    const r = this.region;
    this.uiLayer.visible(false);
    this.stage.scale({ x: 1, y: 1 });
    this.stage.size({ width: r.width, height: r.height });
    this.stage.position({ x: -r.x, y: -r.y });
    try {
      const canvas = this.stage.toCanvas({ pixelRatio: 1 });
      return await new Promise((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("export failed"))), "image/png"),
      );
    } finally {
      this.applyFit();
      this.uiLayer.visible(true);
    }
  }

  // --------------------------------------------------------- cropping ---

  /**
   * Shows the whole image with a movable, resizable crop frame. `onChange`
   * receives the frame in image pixels whenever it moves.
   */
  startCrop(initial: Rect, onChange: (r: Rect) => void): void {
    this.endCrop();
    this.transformer.nodes([]);
    this.baseLayer.listening(false);
    this.redactLayer.listening(false);
    this.annotationLayer.listening(false);

    const full = this.fullImage();
    const rect = new Konva.Rect({ ...initial, fill: "rgba(0, 0, 0, 0)", draggable: true, name: "crop-frame" });
    const live = (): Rect => ({
      x: rect.x(),
      y: rect.y(),
      width: rect.width() * rect.scaleX(),
      height: rect.height() * rect.scaleY(),
    });
    const emit = () => onChange(roundRect(live()));

    const shade = new Konva.Shape({
      listening: false,
      sceneFunc: (ctx) => {
        const c = ctx._context;
        const r = live();
        c.save();
        c.fillStyle = "rgba(0, 0, 0, 0.55)";
        c.beginPath();
        c.rect(0, 0, full.width, full.height);
        c.rect(r.x, r.y, r.width, r.height);
        c.fill("evenodd");
        // Rule-of-thirds grid.
        c.strokeStyle = "rgba(255, 255, 255, 0.5)";
        c.lineWidth = 1 / this.scale;
        c.beginPath();
        for (const f of [1 / 3, 2 / 3]) {
          c.moveTo(r.x + r.width * f, r.y);
          c.lineTo(r.x + r.width * f, r.y + r.height);
          c.moveTo(r.x, r.y + r.height * f);
          c.lineTo(r.x + r.width, r.y + r.height * f);
        }
        c.stroke();
        c.restore();
      },
    });

    const transformer = new Konva.Transformer({
      nodes: [rect],
      rotateEnabled: false,
      flipEnabled: false,
      keepRatio: false,
      borderStroke: "#ffffff",
      borderStrokeWidth: 1.5,
      anchorStroke: SELECTION_COLOR,
      anchorFill: "#ffffff",
      anchorSize: 10,
      ignoreStroke: true,
      // Boxes are in stage pixels; the image starts at the crop margin.
      boundBoxFunc: (oldBox, box) => {
        const s = this.scale;
        const m = CROP_MARGIN;
        const inside =
          box.x >= m - 0.5 &&
          box.y >= m - 0.5 &&
          box.x + box.width <= m + full.width * s + 0.5 &&
          box.y + box.height <= m + full.height * s + 0.5;
        return inside && box.width >= 8 && box.height >= 8 ? box : oldBox;
      },
    });

    rect.on("dragmove", () => {
      const r = live();
      rect.position({
        x: Math.min(Math.max(0, r.x), full.width - r.width),
        y: Math.min(Math.max(0, r.y), full.height - r.height),
      });
      emit();
    });
    rect.on("transform", emit);
    rect.on("transformend", () => {
      const r = roundRect(live());
      rect.setAttrs({ ...r, scaleX: 1, scaleY: 1 });
      emit();
    });

    // Dragging outside the frame (or while it still covers the whole
    // image) draws a new frame; inside a smaller frame it moves the frame.
    let drawFrom: { x: number; y: number } | null = null;
    const pointer = () => {
      const p = this.stage.getRelativePointerPosition() ?? { x: 0, y: 0 };
      return { x: Math.min(Math.max(0, p.x), full.width), y: Math.min(Math.max(0, p.y), full.height) };
    };
    this.stage.on("mousedown.crop touchstart.crop", (e) => {
      if (transformer.isAncestorOf(e.target)) return;
      const r = live();
      const coversAll = r.x <= 0 && r.y <= 0 && r.width >= full.width && r.height >= full.height;
      if (e.target === rect && !coversAll) return;
      rect.draggable(false);
      drawFrom = pointer();
    });
    this.stage.on("mousemove.crop touchmove.crop", () => {
      if (!drawFrom) return;
      const p = pointer();
      let width = Math.abs(p.x - drawFrom.x);
      let height = Math.abs(p.y - drawFrom.y);
      const ratio = this.cropUi?.ratio ?? null;
      if (ratio) {
        // Follow the larger movement, then stay inside the image.
        if (width / ratio > height) height = width / ratio;
        else width = height * ratio;
        const maxW = p.x >= drawFrom.x ? full.width - drawFrom.x : drawFrom.x;
        const maxH = p.y >= drawFrom.y ? full.height - drawFrom.y : drawFrom.y;
        const k = Math.min(1, maxW / width, maxH / height);
        width *= k;
        height *= k;
      }
      if (width < MIN_CROP || height < MIN_CROP) return;
      rect.setAttrs({
        x: p.x >= drawFrom.x ? drawFrom.x : drawFrom.x - width,
        y: p.y >= drawFrom.y ? drawFrom.y : drawFrom.y - height,
        width,
        height,
        scaleX: 1,
        scaleY: 1,
      });
      emit();
    });
    const finishDraw = () => {
      if (!drawFrom) return;
      drawFrom = null;
      rect.draggable(true);
      rect.setAttrs({ ...roundRect(live()), scaleX: 1, scaleY: 1 });
      emit();
    };
    this.stage.on("mouseup.crop touchend.crop", finishDraw);
    this.cropPointerUp = finishDraw;
    window.addEventListener("pointerup", finishDraw);

    const group = new Konva.Group();
    group.add(shade, rect, transformer);
    this.uiLayer.add(group);
    this.cropUi = { group, rect, transformer, ratio: null };
    this.applyFit();
    emit();
  }

  private cropPointerUp: (() => void) | null = null;

  /** Moves the crop frame; `ratio` locks the aspect ratio (null = free). */
  setCrop(r: Rect, ratio: number | null): void {
    if (!this.cropUi) return;
    const { rect, transformer } = this.cropUi;
    this.cropUi.ratio = ratio;
    rect.setAttrs({ ...r, scaleX: 1, scaleY: 1 });
    transformer.keepRatio(ratio !== null);
    transformer.enabledAnchors(
      ratio !== null
        ? ["top-left", "top-right", "bottom-left", "bottom-right"]
        : ["top-left", "top-center", "top-right", "middle-right", "bottom-right", "bottom-center", "bottom-left", "middle-left"],
    );
    rect.fire("transformend");
  }

  /** The crop frame in CSS pixels relative to the stage element. */
  cropFrameOnScreen(): Rect | null {
    if (!this.cropUi) return null;
    const r = this.cropUi.rect;
    return {
      x: CROP_MARGIN + r.x() * this.scale,
      y: CROP_MARGIN + r.y() * this.scale,
      width: r.width() * r.scaleX() * this.scale,
      height: r.height() * r.scaleY() * this.scale,
    };
  }

  endCrop(): void {
    if (!this.cropUi) return;
    this.stage.off(".crop");
    if (this.cropPointerUp) window.removeEventListener("pointerup", this.cropPointerUp);
    this.cropPointerUp = null;
    this.cropUi.group.destroy();
    this.cropUi = null;
    this.baseLayer.listening(true);
    this.redactLayer.listening(true);
    this.annotationLayer.listening(true);
    this.applyFit();
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
      case "redact":
        this.drawRedaction(group, a);
        break;
      case "spotlight":
        this.drawSpotlight(group, a);
        break;
      case "highlight":
        this.drawHighlight(group, a);
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
            hitStrokeWidth: Math.max(width, this.hitTolerance()),
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
    const size = textFontSize(t, this.pixelRatio);
    const box = t.textBackground === "white" || t.textBackground === "color";
    const label = new Konva.Label();
    label.add(
      new Konva.Tag(
        box
          ? {
              fill: t.textBackground === "color" ? t.color : "#ffffff",
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
        fontStyle: textFontStyle(t),
        lineHeight: TEXT_LINE_HEIGHT,
        fill: t.textBackground === "color" ? contrastColor(t.color) : t.color,
        padding: textPadding(t, this.pixelRatio),
        // Halo: white outline drawn behind the letters.
        ...(t.textBackground === "halo"
          ? {
              stroke: "#ffffff",
              strokeWidth: size * 0.22,
              lineJoin: "round" as const,
              fillAfterStrokeEnabled: true,
            }
          : {}),
      }),
    );
    group.add(label);
  }


  /** Arrow points are absolute; the group offset is the drag delta. */
  private drawArrow(group: Konva.Group, a: Arrow): void {
    group.destroyChildren();
    const width = strokeWidth(a.size, this.pixelRatio);
    const angle = Math.atan2(a.y2 - a.y, a.x2 - a.x);
    // A filled head covers the line end; stop the line short of the tip so
    // its round cap doesn't poke through.
    const inset = (head: string) => (head === "filled" ? headLength(width) * 0.8 : 0);
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const start = { x: a.x + dx * inset(a.startHead), y: a.y + dy * inset(a.startHead) };
    const end = { x: a.x2 - dx * inset(a.endHead), y: a.y2 - dy * inset(a.endHead) };

    group.add(
      new Konva.Line({
        points: [start.x, start.y, end.x, end.y],
        stroke: a.color,
        strokeWidth: width,
        lineCap: "round",
        hitStrokeWidth: Math.max(width, this.hitTolerance()),
      }),
    );
    if (a.endHead !== "none") group.add(arrowHead(a.x2, a.y2, angle, a.endHead, a.color, width));
    if (a.startHead !== "none") group.add(arrowHead(a.x, a.y, angle + Math.PI, a.startHead, a.color, width));
  }

  private drawMagnifier(group: Konva.Group, m: Magnifier): void {
    group.position({ x: m.x, y: m.y });
    const { naturalWidth: w, naturalHeight: h } = this.image;
    const ring = strokeWidth(m.size, this.pixelRatio);

    const lens = new Konva.Group({
      clipFunc: (ctx) => ctx.arc(0, 0, m.radius, 0, Math.PI * 2, false),
    });
    // Zoom into the redacted image so a lens can't reveal hidden content.
    const zoomed = new Konva.Image({ image: this.baseImage(), width: w * m.zoom, height: h * m.zoom });
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

  /** Hit tolerance for thin strokes in image pixels (constant on screen). */
  private hitTolerance(): number {
    return HIT_TOLERANCE / this.scale;
  }

  /** Invisible fill that makes the whole inside clickable, or none. */
  private areaHit(kind: "frame" | "spotlight"): Konva.ShapeConfig {
    const whole = this.tool === "select" || this.tool === kind;
    return whole ? { fill: "rgba(0, 0, 0, 0)" } : { fillEnabled: false };
  }

  private drawFrame(group: Konva.Group, f: Frame): void {
    group.position({ x: f.x, y: f.y });
    const width = strokeWidth(f.size, this.pixelRatio);
    const common = {
      stroke: f.color,
      strokeWidth: width,
      hitStrokeWidth: Math.max(width, this.hitTolerance()),
      ...this.areaHit("frame"),
    };
    group.add(outlineShape(f.shape, f.width, f.height, { ...common, cornerRadius: width }));
  }

  private drawRedaction(group: Konva.Group, r: Redaction): void {
    group.position({ x: r.x, y: r.y });
    if (r.redactMode === "solid") {
      group.add(new Konva.Rect({ width: r.width, height: r.height, fill: r.color }));
      return;
    }
    // Show the matching part of a fully processed copy of the image; the
    // crop follows while dragging.
    const content = new Konva.Image({
      image: this.redactedImage(r),
      width: r.width,
      height: r.height,
      crop: { x: r.x, y: r.y, width: r.width, height: r.height },
    });
    group.on("dragmove", () =>
      content.crop({ x: group.x(), y: group.y(), width: r.width, height: r.height }),
    );
    group.add(content);
  }

  private drawHighlight(group: Konva.Group, h: Highlight): void {
    group.position({ x: h.x, y: h.y });
    group.add(
      new Konva.Rect({
        width: h.width,
        height: h.height,
        fill: h.highlightColor,
        cornerRadius: Math.min(h.width, h.height) * 0.08,
        // Like a real highlighter: the colour darkens the image below,
        // dark text stays dark.
        globalCompositeOperation: "multiply",
      }),
    );
  }

  private drawSpotlight(group: Konva.Group, s: Spotlight): void {
    group.position({ x: s.x, y: s.y });
    // Invisible shape as grab handle; the dimming shows the area.
    group.add(
      outlineShape(s.shape, s.width, s.height, {
        stroke: "rgba(0, 0, 0, 0)",
        strokeWidth: 1,
        hitStrokeWidth: this.hitTolerance(),
        ...this.areaHit("spotlight"),
      }),
    );
  }

  /** Dims everything except the spotlight areas (live node geometry). */
  private drawDimming(ctx: CanvasRenderingContext2D): void {
    if (this.spotlights.length === 0) return;
    const opacity = Math.max(...this.spotlights.map((s) => dimOpacity(s.spot.size)));
    ctx.save();
    ctx.fillStyle = `rgba(0, 0, 0, ${opacity})`;
    ctx.fillRect(0, 0, this.image.naturalWidth, this.image.naturalHeight);
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "#000";
    for (const { node, spot } of this.spotlights) {
      const w = spot.width * node.scaleX();
      const h = spot.height * node.scaleY();
      ctx.beginPath();
      if (spot.shape === "ellipse") {
        ctx.ellipse(node.x() + w / 2, node.y() + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      } else {
        ctx.rect(node.x(), node.y(), w, h);
      }
      ctx.fill();
    }
    ctx.restore();
  }

  // ---------------------------------------------------- derived images ---

  private derived(key: string, draw: (ctx: CanvasRenderingContext2D) => void): HTMLCanvasElement {
    let canvas = this.cache.get(key);
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.width = this.image.naturalWidth;
      canvas.height = this.image.naturalHeight;
      draw(canvas.getContext("2d")!);
      this.cache.set(key, canvas);
    }
    return canvas;
  }

  /** Whole image processed with a redaction's mode and strength. */
  private redactedImage(r: Redaction): HTMLCanvasElement {
    const { naturalWidth: w, naturalHeight: h } = this.image;
    if (r.redactMode === "pixelate") {
      const block = pixelBlockSize(r.size, this.pixelRatio);
      return this.derived(`pixelate:${block}`, (ctx) => {
        // Downscale (averaging), then upscale without smoothing.
        const small = document.createElement("canvas");
        small.width = Math.ceil(w / block);
        small.height = Math.ceil(h / block);
        small.getContext("2d")!.drawImage(this.image, 0, 0, small.width, small.height);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(small, 0, 0, small.width * block, small.height * block);
      });
    }
    const radius = redactBlurRadius(r.size, this.pixelRatio);
    return this.derived(`blur:${radius}`, (ctx) => drawBlurred(ctx, this.image, radius));
  }

  /** Rebuilds the redacted base image when the redactions changed. */
  private updateBase(redactions: Redaction[]): void {
    const key = JSON.stringify(redactions.map(({ id: _, ...r }) => r));
    if (this.base?.key === key) return;
    if (redactions.length === 0) {
      this.base = null;
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = this.image.naturalWidth;
    canvas.height = this.image.naturalHeight;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(this.image, 0, 0);
    for (const r of redactions) {
      if (r.redactMode === "solid") {
        ctx.fillStyle = r.color;
        ctx.fillRect(r.x, r.y, r.width, r.height);
      } else {
        ctx.drawImage(this.redactedImage(r), r.x, r.y, r.width, r.height, r.x, r.y, r.width, r.height);
      }
    }
    this.base = { key, canvas };
  }

  private baseImage(): HTMLImageElement | HTMLCanvasElement {
    return this.base?.canvas ?? this.image;
  }

  /** Base image blurred, shown beneath lenses with `blurOutside`. */
  private blurredBase(): HTMLCanvasElement {
    const source = this.baseImage();
    return this.derived(`outside:${this.base?.key ?? ""}`, (ctx) =>
      drawBlurred(ctx, source, BLUR_RADIUS * this.pixelRatio),
    );
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
      case "redact":
      case "spotlight":
      case "highlight":
        this.showBoxTransformer(a, node);
        return;
    }
  }

  private showBoxTransformer(a: BoxAnnotation, node: Konva.Group): void {
    this.showTransformer(node, "free");
    node.on("transformend", () =>
      this.callbacks.onUpdate(a.id, {
        x: node.x(),
        y: node.y(),
        width: Math.max(1, a.width * node.scaleX()),
        height: Math.max(1, a.height * node.scaleY()),
      }),
    );
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
      // A highlighter only blends ("multiply") with the image in the image's
      // own layer; in the UI layer the preview would look opaque.
      const layer = draft.kind === "highlight" ? this.highlightGroup : this.uiLayer;
      if (preview.getParent() !== layer) preview.moveTo(layer);
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

/**
 * Draws `source` blurred by roughly `radius` pixels: three box-blur passes
 * (close to a Gaussian) on a moderately downscaled copy. Done in JS because
 * WebKit ignores `ctx.filter`.
 */
function drawBlurred(
  ctx: CanvasRenderingContext2D,
  source: HTMLImageElement | HTMLCanvasElement,
  radius: number,
): void {
  const { width, height } = ctx.canvas;
  // Downscale only so far that a few pixels of blur remain; keeps it fast.
  // Half resolution at least: looks the same, about four times faster.
  const factor = Math.max(2, Math.floor(radius / 3));
  const small = document.createElement("canvas");
  small.width = Math.max(1, Math.round(width / factor));
  small.height = Math.max(1, Math.round(height / factor));
  const sctx = small.getContext("2d")!;
  sctx.imageSmoothingQuality = "high";
  sctx.drawImage(source, 0, 0, small.width, small.height);

  const image = sctx.getImageData(0, 0, small.width, small.height);
  const r = Math.max(1, Math.round(radius / factor / 2));
  let data: Uint8ClampedArray = image.data;
  for (let pass = 0; pass < 3; pass++) {
    data = boxBlur(data, small.width, small.height, r, true);
    data = boxBlur(data, small.width, small.height, r, false);
  }
  image.data.set(data);
  sctx.putImageData(image, 0, 0);

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(small, 0, 0, width, height);
}

/** One box-blur pass along rows (`horizontal`) or columns; edges clamped. */
function boxBlur(
  src: Uint8ClampedArray,
  width: number,
  height: number,
  r: number,
  horizontal: boolean,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  const length = horizontal ? width : height;
  const lines = horizontal ? height : width;
  const step = horizontal ? 4 : width * 4;
  const size = 2 * r + 1;
  const at = (i: number) => Math.min(length - 1, Math.max(0, i)) * step;

  for (let line = 0; line < lines; line++) {
    const base = horizontal ? line * width * 4 : line * 4;
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += src[base + at(k) + c];
      for (let i = 0; i < length; i++) {
        out[base + i * step + c] = sum / size;
        sum += src[base + at(i + r + 1) + c] - src[base + at(i - r) + c];
      }
    }
  }
  return out;
}

/** Rectangle or ellipse filling the box (0, 0, width, height). */
function outlineShape(
  shape: FrameShape,
  width: number,
  height: number,
  config: Konva.ShapeConfig & { cornerRadius?: number },
): Konva.Shape {
  const { cornerRadius, ...common } = config;
  return shape === "ellipse"
    ? new Konva.Ellipse({ x: width / 2, y: height / 2, radiusX: width / 2, radiusY: height / 2, ...common })
    : new Konva.Rect({ width, height, cornerRadius, lineJoin: "round", ...common });
}

function roundRect(r: Rect): Rect {
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
}

function annotationId(target: Konva.Node): string | null {
  const node = target.findAncestor(".annotation", true);
  return node ? node.id() : null;
}

function isHandle(target: Konva.Node): boolean {
  return target.hasName("handle") || target.hasName("crop-frame");
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
