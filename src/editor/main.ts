// Editor controller: owns the documents (one per capture), the active tool
// and style, and wires tools, settings panel, film strip and keyboard.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { storedImageUrl } from "../images";
import { AnnotationCanvas, FONT_FAMILY, TEXT_LINE_HEIGHT, textPadding, type Point } from "./canvas";
import { History } from "./history";
import {
  type Annotation,
  type FrameShape,
  type Head,
  type Kind,
  type MarkerKind,
  type Rect,
  type RedactMode,
  type Size,
  type Style,
  type TextBackground,
  type TextNote,
  COLORS,
  CROP_RATIOS,
  HIGHLIGHT_COLORS,
  TEXT_SIZE_RANGE,
  contrastColor,
  DEFAULT_STYLE,
  MAGNIFIER_COLOR,
  cropOf,
  defaultMagnifierRadius,
  fitRatio,
  stepTextSize,
  textFontSize,
  migrate,
  newId,
  nextMarkerLabel,
  spanRect,
  styleFor,
  translate,
} from "./model";

type Tool = "select" | Kind;

/** One capture with its annotations and undo history. */
interface Doc {
  id: number;
  image: HTMLImageElement;
  history: History<readonly Annotation[]>;
  selectedId: string | null;
  thumb: string;
}

const IS_MAC = navigator.userAgent.includes("Mac");
const STAGE_MARGIN = 24;
const PATH_HEADER = "x-pasta-path";
const SAVE_DELAY_MS = 400;
const THUMB_SIZE = { width: 300, height: 152 };

const TOOL_NAMES: Record<Tool, string> = {
  select: "Auswählen",
  marker: "Nummer",
  text: "Text",
  arrow: "Pfeil",
  frame: "Rahmen",
  spotlight: "Betonen",
  redact: "Unkenntlich",
  magnifier: "Lupe",
  crop: "Zuschneiden",
  highlight: "Textmarker",
};

const TOOL_HINTS: Record<Tool, string> = {
  select: "Element anklicken, um es zu verschieben oder zu ändern. Rahmen und betonte Bereiche lassen sich auf der ganzen Fläche greifen.",
  marker: "Klicken setzt die nächste Nummer. Ziehen setzt sie mit Zeigerlinie.",
  text: "Klicken und tippen. Esc übernimmt den Text, Doppelklick bearbeitet ihn.",
  arrow: "Ziehen zeichnet einen Pfeil. Die Endpunkte lassen sich danach einzeln verschieben.",
  frame: "Ziehen zeichnet einen Rahmen zum Einkreisen.",
  spotlight: "Ziehen markiert einen Bereich, der hell bleibt. Der Rest wird abgedunkelt.",
  redact: "Ziehen macht einen Bereich unkenntlich. Schwärzen ist am sichersten.",
  magnifier: "Klicken setzt eine Lupe. An den Ecken ziehen ändert die Größe.",
  highlight: "Ziehen markiert einen Bereich wie mit einem Leuchtstift. Die Schrift darunter bleibt lesbar.",
  crop: "Rahmen an den Anfassern anpassen oder verschieben. ↩ übernimmt, Esc bricht ab. Beschriftungen außerhalb bleiben erhalten.",
};

const SIZE_LABELS: Partial<Record<Kind, string>> = {
  arrow: "Strichstärke",
  frame: "Strichstärke",
  spotlight: "Abdunklung (alle Bereiche)",
  redact: "Stärke",
  magnifier: "Ring",
};

const docs: Doc[] = [];
let doc: Doc | null = null;
let canvas: AnnotationCanvas | null = null;
let tool: Tool = "marker";
let style: Style = { ...DEFAULT_STYLE };
let editing: { draft: TextNote; isNew: boolean; textarea: HTMLTextAreaElement } | null = null;
let saveTimer: number | undefined;
/** Crop tool state: frame being edited and the tool to return to. */
let cropping: { rect: Rect; ratio: number | "original" | null; returnTo: Tool } | null = null;

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const stageArea = $<HTMLElement>("#stage-area");
const stageEl = $<HTMLDivElement>("#stage");

// ---------------------------------------------------------------- state ---

function annotations(): readonly Annotation[] {
  return doc?.history.present ?? [];
}

function selected(): Annotation | undefined {
  return annotations().find((a) => a.id === doc?.selectedId);
}

function commit(next: readonly Annotation[]) {
  if (!doc) return;
  doc.history.push(next);
  refresh();
  scheduleSave();
}

function update(id: string, change: Partial<Annotation> | Partial<Style>) {
  const current = annotations().find((a) => a.id === id) as Record<string, unknown> | undefined;
  const changed = Object.entries(change).some(([k, v]) => current?.[k] !== v);
  if (!changed) {
    refresh();
    return;
  }
  commit(annotations().map((a) => (a.id === id ? ({ ...a, ...change } as Annotation) : a)));
}

function refresh() {
  if (doc && doc.selectedId && !selected()) doc.selectedId = null;
  canvas?.render(annotations(), doc?.selectedId ?? null, editing?.isNew ? undefined : editing?.draft.id);
  updatePanels();
}

function select(id: string | null) {
  if (!doc) return;
  doc.selectedId = id;
  const a = selected();
  if (a) style = { ...style, ...styleFor(a.kind, a as Partial<Style>) };
  updateDraftFactory();
  refresh();
}

function setTool(next: Tool) {
  finishEditing();
  if (tool === "crop" && next !== "crop") endCrop();
  const previous = tool;
  tool = next;
  stageEl.className = `tool-${tool}`;
  if (canvas) canvas.tool = tool;
  updateDraftFactory();
  if (next === "crop" && previous !== "crop") startCrop(previous);
  refresh();
}

// ------------------------------------------------------------- cropping ---

function startCrop(returnTo: Tool) {
  if (!canvas || !doc) return;
  doc.selectedId = null;
  const existing = cropOf(annotations());
  const full = { x: 0, y: 0, width: doc.image.naturalWidth, height: doc.image.naturalHeight };
  const initial = existing ? { x: existing.x, y: existing.y, width: existing.width, height: existing.height } : full;
  cropping = { rect: initial, ratio: null, returnTo: returnTo === "crop" ? "select" : returnTo };
  canvas.startCrop(initial, (r) => {
    if (!cropping) return;
    cropping.rect = r;
    placeCropBar();
  });
  $("#crop-bar").hidden = false;
  updateCropBar();
  placeCropBar();
}

function endCrop() {
  cropping = null;
  canvas?.endCrop();
  $("#crop-bar").hidden = true;
}

function setCropRatio(ratio: number | "original" | null) {
  if (!cropping || !canvas || !doc) return;
  cropping.ratio = ratio;
  const full = { x: 0, y: 0, width: doc.image.naturalWidth, height: doc.image.naturalHeight };
  const value = ratio === "original" ? full.width / full.height : ratio;
  canvas.setCrop(value ? fitRatio(cropping.rect, value, full) : cropping.rect, value);
  updateCropBar();
}

function resetCrop() {
  if (!cropping || !canvas || !doc) return;
  cropping.ratio = null;
  canvas.setCrop({ x: 0, y: 0, width: doc.image.naturalWidth, height: doc.image.naturalHeight }, null);
  updateCropBar();
}

function applyCrop() {
  if (!cropping || !doc) return;
  const r = cropping.rect;
  const returnTo = cropping.returnTo;
  const whole = r.x <= 0 && r.y <= 0 && r.width >= doc.image.naturalWidth && r.height >= doc.image.naturalHeight;
  const rest = annotations().filter((a) => a.kind !== "crop");
  endCrop();
  commit(whole ? rest : [...rest, { kind: "crop", id: newId(), ...r, color: "#000000", size: "m" }]);
  setTool(returnTo);
}

function cancelCrop() {
  if (!cropping) return;
  setTool(cropping.returnTo);
}

function updateCropBar() {
  document.querySelectorAll<HTMLElement>("[data-crop-ratio]").forEach((el) => {
    const value = el.dataset.cropRatio!;
    const current = cropping?.ratio;
    const on = value === "free" ? current === null : value === "original" ? current === "original" : Number(value) === current;
    el.setAttribute("aria-checked", String(on));
  });
}

/** Floating bar below the crop frame (above it if there is no room). */
function placeCropBar() {
  const bar = $<HTMLDivElement>("#crop-bar");
  const frame = canvas?.cropFrameOnScreen();
  if (!frame || !cropping) return;
  $("#crop-size").textContent = `${cropping.rect.width} × ${cropping.rect.height} px`;
  const stageRect = stageEl.getBoundingClientRect();
  const area = stageArea.getBoundingClientRect();
  const gap = 10;
  let top = stageRect.top + frame.y + frame.height + gap;
  if (top + bar.offsetHeight > area.bottom - 4) top = stageRect.top + frame.y + frame.height - bar.offsetHeight - gap;
  let left = stageRect.left + frame.x + frame.width / 2 - bar.offsetWidth / 2;
  left = Math.min(Math.max(area.left + 4, left), area.right - bar.offsetWidth - 4);
  bar.style.top = `${top - area.top}px`;
  bar.style.left = `${left - area.left}px`;
}

/** Applies a style change to the defaults and to the selected annotation. */
function setStyle(change: Partial<Style>) {
  style = { ...style, ...change };
  updateDraftFactory();

  // While typing, the change applies to the text being edited.
  if (editing) {
    editing.draft = { ...editing.draft, ...styleFor("text", change) } as TextNote;
    styleTextarea();
    editing.textarea.focus();
    updatePanels();
    return;
  }

  // The dimming around spotlights is shared, so its strength applies to all.
  if (change.size && contextKind() === "spotlight" && annotations().some((x) => x.kind === "spotlight")) {
    const size = change.size;
    const next = annotations().map((x) => (x.kind === "spotlight" ? { ...x, size } : x));
    if (next.some((x, i) => x !== annotations()[i] && x.size !== annotations()[i].size)) commit(next);
    else updatePanels();
    return;
  }

  const a = selected();
  const relevant = a ? styleFor(a.kind, change) : {};
  if (a && Object.keys(relevant).length > 0) {
    update(a.id, relevant);
  } else {
    updatePanels();
  }
}

/** What dragging on the background creates with the current tool. */
function updateDraftFactory() {
  if (!canvas) return;
  const { color, size } = style;
  switch (tool) {
    case "arrow":
      canvas.draftFactory = (s, e) => ({
        kind: "arrow",
        id: newId(),
        x: s.x,
        y: s.y,
        x2: e.x,
        y2: e.y,
        color,
        size,
        startHead: style.startHead,
        endHead: style.endHead,
      });
      break;
    case "frame":
      canvas.draftFactory = (s, e) => ({ kind: "frame", id: newId(), ...spanRect(s, e), color, size, shape: style.shape });
      break;
    case "redact":
      canvas.draftFactory = (s, e) => ({
        kind: "redact",
        id: newId(),
        ...spanRect(s, e),
        color,
        size,
        redactMode: style.redactMode,
      });
      break;
    case "highlight":
      canvas.draftFactory = (s, e) => ({
        kind: "highlight",
        id: newId(),
        ...spanRect(s, e),
        color,
        size,
        highlightColor: style.highlightColor,
      });
      break;
    case "spotlight":
      // One dimming for the whole image: a new area takes the existing strength.
      canvas.draftFactory = (s, e) => ({
        kind: "spotlight",
        id: newId(),
        ...spanRect(s, e),
        color,
        size: annotations().find((a) => a.kind === "spotlight")?.size ?? size,
        shape: style.shape,
      });
      break;
    case "marker":
      // Click: plain marker (onBackgroundClick). Drag: marker with pointer.
      canvas.draftFactory = (s, e) => ({
        kind: "marker",
        id: newId(),
        x: s.x,
        y: s.y,
        tx: e.x,
        ty: e.y,
        color,
        size,
        label: nextMarkerLabel(annotations(), style.markerKind),
      });
      break;
    default:
      canvas.draftFactory = null;
  }
}

/** Kind whose options the panel shows: the selection, else the tool. */
function contextKind(): Kind | "none" {
  return selected()?.kind ?? (tool === "select" ? "none" : tool);
}

function deleteSelected() {
  if (!doc?.selectedId) return;
  const id = doc.selectedId;
  commit(annotations().filter((a) => a.id !== id));
}

function undo() {
  if (!doc) return;
  finishEditing();
  doc.history.undo();
  refresh();
  scheduleSave();
}

function redo() {
  if (!doc) return;
  finishEditing();
  doc.history.redo();
  refresh();
  scheduleSave();
}

// ------------------------------------------------------------ documents ---

async function loadDoc(id: number): Promise<Doc> {
  const image = new Image();
  image.crossOrigin = "anonymous"; // keeps the canvas exportable
  image.src = storedImageUrl(`capture-${id}.png`);
  await image.decode();

  let saved: Annotation[] = [];
  const json = await invoke<string | null>("load_annotations", { id });
  if (json) {
    try {
      saved = migrate(JSON.parse(json));
    } catch {
      saved = [];
    }
  }
  return { id, image, history: new History<readonly Annotation[]>(saved), selectedId: null, thumb: image.src };
}

function switchTo(next: Doc | null) {
  finishEditing();
  if (tool === "crop") {
    endCrop();
    tool = "select";
  }
  flushSave();
  canvas?.destroy();
  canvas = null;
  doc = next;

  $("#empty").hidden = !!next;
  stageEl.hidden = !next;
  if (next) {
    canvas = new AnnotationCanvas(stageEl, next.image, window.devicePixelRatio, {
      onBackgroundClick,
      onSelect: select,
      onTranslate,
      onUpdate: update,
      onEditText,
      onDraw,
    });
    canvas.tool = tool;
    updateDraftFactory();
    layout();
  }
  refresh();
  if (canvas && next && next.history.present.length > 0) {
    next.thumb = canvas.thumbnail(THUMB_SIZE.width, THUMB_SIZE.height);
  }
  renderStrip();
}

async function removeDoc(id: number) {
  const index = docs.findIndex((d) => d.id === id);
  if (index < 0) return;
  await invoke("remove_capture", { id });
  const [removed] = docs.splice(index, 1);
  if (removed === doc) {
    doc = null; // already gone; nothing to save
    switchTo(docs[Math.min(index, docs.length - 1)] ?? null);
  } else {
    renderStrip();
  }
}

/** Persists annotations and refreshes the thumbnail, debounced. */
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(flushSave, SAVE_DELAY_MS);
}

function flushSave() {
  if (saveTimer === undefined) return;
  clearTimeout(saveTimer);
  saveTimer = undefined;
  if (!doc || !canvas) return;
  void invoke("save_annotations", { id: doc.id, json: JSON.stringify(doc.history.present) });
  doc.thumb = canvas.thumbnail(THUMB_SIZE.width, THUMB_SIZE.height);
  const img = document.querySelector<HTMLImageElement>(`.thumb[data-id="${doc.id}"] img`);
  if (img) img.src = doc.thumb;
}

function renderStrip() {
  const thumbs = $<HTMLDivElement>("#thumbs");
  thumbs.innerHTML = "";
  docs.forEach((d, i) => {
    const item = document.createElement("div");
    item.className = "thumb";
    item.dataset.id = String(d.id);
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(d === doc));
    item.setAttribute("aria-label", `Aufnahme ${i + 1}`);
    item.innerHTML = `<img alt="" src="${d.thumb}"><button class="remove" aria-label="Aufnahme entfernen">×</button>`;
    item.addEventListener("click", () => {
      if (d !== doc) switchTo(d);
    });
    item.querySelector(".remove")!.addEventListener("click", (e) => {
      e.stopPropagation();
      void removeDoc(d.id);
    });
    thumbs.append(item);
  });
  thumbs.querySelector('[aria-selected="true"]')?.scrollIntoView({ inline: "nearest", block: "nearest" });
}

// --------------------------------------------------------------- canvas ---

function onBackgroundClick(p: Point) {
  const { color, size } = style;
  if (tool === "marker") {
    commit([
      ...annotations(),
      { kind: "marker", id: newId(), x: p.x, y: p.y, color, size, label: nextMarkerLabel(annotations(), style.markerKind) },
    ]);
  } else if (tool === "text") {
    if (doc?.selectedId) select(null);
    startEditing(
      {
        kind: "text",
        id: newId(),
        x: p.x,
        y: p.y,
        color,
        size,
        textBackground: style.textBackground,
        textSize: style.textSize,
        bold: style.bold,
        italic: style.italic,
        text: "",
      },
      true,
    );
  } else if (tool === "magnifier" && doc && canvas) {
    const id = newId();
    doc.selectedId = id;
    commit([
      ...annotations(),
      {
        kind: "magnifier",
        id,
        x: p.x,
        y: p.y,
        color: MAGNIFIER_COLOR,
        size,
        radius: defaultMagnifierRadius(canvas.pixelRatio),
        zoom: style.zoom,
        blurOutside: style.blurOutside,
      },
    ]);
  } else if (tool === "select") {
    select(null);
  }
  // Other tools create by dragging (onDraw).
}

function onDraw(annotation: Annotation) {
  // Markers are placed in series; keep them unselected like plain clicks.
  if (annotation.kind !== "marker" && doc) doc.selectedId = annotation.id;
  commit([...annotations(), annotation]);
}

function onTranslate(id: string, dx: number, dy: number) {
  if (dx === 0 && dy === 0) return;
  commit(annotations().map((a) => (a.id === id ? translate(a, dx, dy) : a)));
}

function onEditText(id: string) {
  const a = annotations().find((x) => x.id === id);
  if (a?.kind === "text") {
    select(id);
    startEditing({ ...a }, false);
  }
}

function layout() {
  canvas?.fit(stageArea.clientWidth - 2 * STAGE_MARGIN, stageArea.clientHeight - 2 * STAGE_MARGIN);
}

// --------------------------------------------------------- text editing ---

function startEditing(draft: TextNote, isNew: boolean) {
  if (!canvas) return;
  if (editing) finishEditing();

  const textarea = document.createElement("textarea");
  textarea.className = "text-editor";
  textarea.value = draft.text;
  textarea.spellcheck = true;
  editing = { draft, isNew, textarea };
  styleTextarea();

  const autosize = () => autosizeTextarea(textarea);
  textarea.addEventListener("input", autosize);
  textarea.addEventListener("blur", () => finishEditing());
  textarea.addEventListener("keydown", (e) => {
    e.stopPropagation();
    // ⌘+ / ⌘− (Ctrl on Windows): font size while typing.
    if ((IS_MAC ? e.metaKey : e.ctrlKey) && ["+", "=", "-"].includes(e.key)) {
      e.preventDefault();
      setStyle({ textSize: stepTextSize(style.textSize, e.key === "-" ? -1 : 1) });
      return;
    }
    if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
      e.preventDefault();
      finishEditing();
    }
  });

  document.body.append(textarea);
  refresh();
  autosize();
  textarea.focus();
  textarea.select();
}

/** Places and styles the text field like the text it will become. */
function styleTextarea() {
  if (!editing || !canvas) return;
  const { draft, textarea } = editing;
  const scale = canvas.viewScale;
  const origin = canvas.viewOrigin;
  const stageRect = stageEl.getBoundingClientRect();
  const fs = textFontSize(draft, canvas.pixelRatio) * scale;
  const pad = textPadding(draft, canvas.pixelRatio) * scale;
  Object.assign(textarea.style, {
    left: `${stageRect.left + (draft.x - origin.x) * scale - 1}px`,
    top: `${stageRect.top + (draft.y - origin.y) * scale - 1}px`,
    font: `${draft.italic ? "italic " : ""}${draft.bold ? "bold " : ""}${fs}px ${FONT_FAMILY}`,
    lineHeight: String(TEXT_LINE_HEIGHT),
    padding: `${pad}px`,
    color: draft.textBackground === "color" ? contrastColor(draft.color) : draft.color,
    background:
      draft.textBackground === "white" ? "#ffffff" : draft.textBackground === "color" ? draft.color : "",
    // Approximates the white outline of the "halo" background.
    textShadow: draft.textBackground === "halo" ? "0 0 2px #fff, 0 0 3px #fff, 0 0 4px #fff" : "",
  });
  autosizeTextarea(textarea);
}

function autosizeTextarea(textarea: HTMLTextAreaElement) {
  textarea.style.width = "0";
  textarea.style.height = "0";
  textarea.style.width = `${textarea.scrollWidth}px`;
  textarea.style.height = `${textarea.scrollHeight}px`;
}

function finishEditing() {
  if (!editing) return;
  const { draft, isNew, textarea } = editing;
  editing = null;
  textarea.remove();

  const text = textarea.value.replace(/\s+$/, "");
  if (isNew) {
    if (text && doc) {
      doc.selectedId = draft.id;
      commit([...annotations(), { ...draft, text }]);
    } else {
      refresh();
    }
  } else if (!text) {
    commit(annotations().filter((a) => a.id !== draft.id));
  } else {
    // Style may have been changed while typing; `update` skips no-ops.
    const { color, textSize, textBackground, bold, italic } = draft;
    update(draft.id, { text, color, textSize, textBackground, bold, italic });
  }
}

// --------------------------------------------------------------- output ---

async function renderPng(): Promise<Uint8Array> {
  // An open crop frame is what the user sees as the result; take it over.
  if (cropping) applyCrop();
  if (!canvas) throw new Error("Keine Aufnahme geöffnet");
  const blob = await canvas.exportPng();
  return new Uint8Array(await blob.arrayBuffer());
}

function defaultFileName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `Pasta ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}.png`;
}

async function copyToClipboard() {
  finishEditing();
  try {
    await invoke("copy_png", await renderPng());
    toast("In die Zwischenablage kopiert");
  } catch (e) {
    toast(`Kopieren fehlgeschlagen: ${e}`, true);
  }
}

async function saveTo(path: string) {
  finishEditing();
  try {
    const written = await invoke<string>("save_png", await renderPng(), {
      headers: { [PATH_HEADER]: encodeURIComponent(path) },
    });
    toast(`Gespeichert: ${written}`);
  } catch (e) {
    toast(`Speichern fehlgeschlagen: ${e}`, true);
  }
}

async function saveAs() {
  finishEditing();
  if (!doc) return;
  const path = await save({
    defaultPath: defaultFileName(),
    filters: [{ name: "PNG-Bild", extensions: ["png"] }],
  });
  if (path) await saveTo(path);
}

let toastTimer: number | undefined;
function toast(message: string, error = false) {
  const el = $<HTMLDivElement>("#toast");
  el.textContent = message;
  el.classList.toggle("error", error);
  el.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove("visible"), error ? 5000 : 2500);
}

// --------------------------------------------------------------- panels ---

function buildPanels() {
  const colors = $<HTMLDivElement>("#colors");
  for (const c of COLORS) {
    const button = document.createElement("button");
    button.className = "swatch";
    button.dataset.color = c.value;
    button.title = c.name;
    button.setAttribute("aria-label", c.name);
    button.innerHTML = `<span style="background:${c.value}"></span>`;
    colors.append(button);
  }

  const highlightColors = $<HTMLDivElement>("#highlight-colors");
  for (const c of HIGHLIGHT_COLORS) {
    const button = document.createElement("button");
    button.className = "swatch";
    button.dataset.highlightColor = c.value;
    button.title = c.name;
    button.setAttribute("aria-label", c.name);
    button.innerHTML = `<span style="background:${c.value}"></span>`;
    highlightColors.append(button);
  }

  const on = (selector: string, handler: (el: HTMLElement) => void) =>
    document.querySelectorAll<HTMLElement>(selector).forEach((el) => el.addEventListener("click", () => handler(el)));

  on("[data-tool]", (el) => setTool(el.dataset.tool as Tool));
  on("[data-color]", (el) => setStyle({ color: el.dataset.color }));
  on("[data-highlight-color]", (el) => setStyle({ highlightColor: el.dataset.highlightColor }));
  on("[data-size]", (el) => setStyle({ size: el.dataset.size as Size }));
  on("[data-start-head]", (el) => setStyle({ startHead: el.dataset.startHead as Head }));
  on("[data-end-head]", (el) => setStyle({ endHead: el.dataset.endHead as Head }));
  on("[data-shape]", (el) => setStyle({ shape: el.dataset.shape as FrameShape }));
  on("[data-marker-kind]", (el) => setStyle({ markerKind: el.dataset.markerKind as MarkerKind }));
  on("[data-redact-mode]", (el) => setStyle({ redactMode: el.dataset.redactMode as RedactMode }));
  on("[data-zoom]", (el) => setStyle({ zoom: Number(el.dataset.zoom) }));
  on("[data-text-background]", (el) => setStyle({ textBackground: el.dataset.textBackground as TextBackground }));
  $("#bold").addEventListener("click", () => setStyle({ bold: !style.bold }));
  $("#text-smaller").addEventListener("click", () => setStyle({ textSize: stepTextSize(style.textSize, -1) }));
  $("#text-larger").addEventListener("click", () => setStyle({ textSize: stepTextSize(style.textSize, 1) }));
  $<HTMLInputElement>("#text-size").addEventListener("change", (e) => {
    const value = Math.round(Number((e.target as HTMLInputElement).value));
    if (Number.isFinite(value)) setStyle({ textSize: Math.min(TEXT_SIZE_RANGE.max, Math.max(TEXT_SIZE_RANGE.min, value)) });
  });
  $("#italic").addEventListener("click", () => setStyle({ italic: !style.italic }));
  $<HTMLInputElement>("#blur-outside").addEventListener("change", (e) =>
    setStyle({ blurOutside: (e.target as HTMLInputElement).checked }),
  );
  $("#undo").addEventListener("click", undo);
  $("#redo").addEventListener("click", redo);
  $("#copy").addEventListener("click", () => void copyToClipboard());
  $("#save").addEventListener("click", () => void saveTo(defaultFileName()));
  $("#save-as").addEventListener("click", () => void saveAs());
  $("#delete").addEventListener("click", deleteSelected);
  setupHelpMenu();
  $("#crop-apply").addEventListener("click", applyCrop);
  $("#crop-cancel").addEventListener("click", cancelCrop);
  $("#crop-reset").addEventListener("click", resetCrop);
  const ratios = $<HTMLDivElement>("#crop-ratios");
  for (const r of CROP_RATIOS) {
    const b = document.createElement("button");
    b.dataset.cropRatio = r.ratio === null ? "free" : String(r.ratio);
    b.textContent = r.label;
    b.setAttribute("role", "radio");
    b.addEventListener("click", () => setCropRatio(r.ratio));
    ratios.append(b);
  }
  $("#new-capture").addEventListener("click", () => void invoke("start_capture"));
  $("#empty-capture").addEventListener("click", () => void invoke("start_capture"));

  // Buttons must not steal keyboard focus from the editor shortcuts.
  document.querySelectorAll("button").forEach((b) => b.addEventListener("mousedown", (e) => e.preventDefault()));

  setupTooltips();
}

function setupHelpMenu() {
  const button = $<HTMLButtonElement>("#help");
  const menu = $<HTMLDivElement>("#help-menu");
  const setOpen = (open: boolean) => {
    menu.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
  };
  const commands: Record<string, string> = { guide: "open_help", logs: "open_logs", about: "show_about" };

  button.addEventListener("click", () => setOpen(menu.hasAttribute("hidden")));
  menu.querySelectorAll<HTMLButtonElement>("[data-help]").forEach((item) =>
    item.addEventListener("click", () => {
      setOpen(false);
      void invoke(commands[item.dataset.help!]);
    }),
  );
  document.addEventListener("click", (e) => {
    if (!menu.hidden && !button.contains(e.target as Node) && !menu.contains(e.target as Node)) setOpen(false);
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) setOpen(false);
  });
}

const TOOLTIP_DELAY_MS = 400;

/**
 * Custom tooltips from the `title` attributes. Native ones don't reliably
 * show in the webview of a menu bar app, and these look the same everywhere.
 */
function setupTooltips() {
  const tip = $<HTMLDivElement>("#tooltip");
  let timer: number | undefined;

  const hide = () => {
    clearTimeout(timer);
    tip.classList.remove("visible");
  };

  document.querySelectorAll<HTMLElement>("[title]").forEach((el) => {
    let text = el.title;
    if (!IS_MAC) text = text.replace("⇧⌘", "Strg+Umschalt+").replace("⌘", "Strg+");
    el.dataset.tooltip = text;
    el.removeAttribute("title");
    if (!el.hasAttribute("aria-label") && el.tagName === "BUTTON") el.setAttribute("aria-label", text);

    el.addEventListener("mouseenter", () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        tip.textContent = el.dataset.tooltip!;
        const r = el.getBoundingClientRect();
        tip.style.left = "0px";
        tip.classList.add("visible");
        const left = Math.min(
          Math.max(4, r.left + r.width / 2 - tip.offsetWidth / 2),
          window.innerWidth - tip.offsetWidth - 4,
        );
        const below = r.bottom + 6 + tip.offsetHeight < window.innerHeight;
        tip.style.left = `${left}px`;
        tip.style.top = `${below ? r.bottom + 6 : r.top - tip.offsetHeight - 6}px`;
      }, TOOLTIP_DELAY_MS);
    });
    el.addEventListener("mouseleave", hide);
    el.addEventListener("mousedown", hide);
  });
}

function updatePanels() {
  const check = (selector: string, isOn: (el: HTMLElement) => boolean) =>
    document.querySelectorAll<HTMLElement>(selector).forEach((el) => {
      el.setAttribute("role", "radio");
      el.setAttribute("aria-checked", String(isOn(el)));
    });
  check("[data-tool]", (el) => el.dataset.tool === tool);
  check("[data-color]", (el) => el.dataset.color === style.color);
  check("[data-highlight-color]", (el) => el.dataset.highlightColor === style.highlightColor);
  check("[data-size]", (el) => el.dataset.size === style.size);
  check("[data-start-head]", (el) => el.dataset.startHead === style.startHead);
  check("[data-end-head]", (el) => el.dataset.endHead === style.endHead);
  check("[data-zoom]", (el) => Number(el.dataset.zoom) === style.zoom);
  check("[data-shape]", (el) => el.dataset.shape === style.shape);
  check("[data-redact-mode]", (el) => el.dataset.redactMode === style.redactMode);
  check("[data-marker-kind]", (el) => el.dataset.markerKind === style.markerKind);
  check("[data-text-background]", (el) => el.dataset.textBackground === style.textBackground);
  $("#bold").setAttribute("aria-pressed", String(style.bold));
  const sizeInput = $<HTMLInputElement>("#text-size");
  if (document.activeElement !== sizeInput) sizeInput.value = String(style.textSize);
  $("#italic").setAttribute("aria-pressed", String(style.italic));
  $<HTMLInputElement>("#blur-outside").checked = style.blurOutside;

  const kind = contextKind();
  document.querySelectorAll<HTMLElement>("[data-for]").forEach((el) => {
    el.hidden = !el.dataset.for!.split(" ").includes(kind);
  });
  // Hide a section (and its heading) when none of its rows apply.
  document.querySelectorAll<HTMLElement>(".props-section").forEach((section) => {
    section.hidden = !section.querySelector("[data-for]:not([hidden])");
  });

  const sel = selected();
  $("#props-title").textContent = sel ? `Ausgewählt: ${TOOL_NAMES[sel.kind]}` : TOOL_NAMES[tool];
  $("#props-hint").textContent = sel
    ? "Änderungen gelten für das ausgewählte Element. Entf löscht es, Esc hebt die Auswahl auf."
    : TOOL_HINTS[tool];
  $("#size-label").textContent = (kind !== "none" && SIZE_LABELS[kind]) || "Größe";
  $("#delete").hidden = !sel;

  $<HTMLButtonElement>("#undo").disabled = !doc?.history.canUndo;
  $<HTMLButtonElement>("#redo").disabled = !doc?.history.canRedo;
  for (const id of ["#copy", "#save", "#save-as"]) $<HTMLButtonElement>(id).disabled = !doc;

  const index = doc ? docs.indexOf(doc) : -1;
  $("#doc-title").textContent = doc
    ? `Aufnahme ${index + 1} von ${docs.length} · ${canvas?.outputSize.width ?? doc.image.naturalWidth} × ${canvas?.outputSize.height ?? doc.image.naturalHeight} px${cropOf(annotations()) ? " (zugeschnitten)" : ""}`
    : "";
}

// ------------------------------------------------------------- keyboard ---

const TOOL_KEYS: Record<string, Tool> = {
  v: "select",
  n: "marker",
  t: "text",
  a: "arrow",
  r: "frame",
  b: "spotlight",
  u: "redact",
  l: "magnifier",
  c: "crop",
  h: "highlight",
};

window.addEventListener("keydown", (e) => {
  if (editing) return;
  // Typing in a settings field (e.g. font size) is not a shortcut.
  if (e.target instanceof HTMLInputElement && e.target.type !== "checkbox") {
    if (e.key === "Enter" || e.key === "Escape") e.target.blur();
    return;
  }
  if (cropping) {
    if (e.key === "Enter") {
      e.preventDefault();
      applyCrop();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      cancelCrop();
      return;
    }
  }
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  const key = e.key.toLowerCase();

  if (mod && key === "z") {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
  } else if (mod && key === "y" && !IS_MAC) {
    e.preventDefault();
    redo();
  } else if (mod && key === "c") {
    e.preventDefault();
    void copyToClipboard();
  } else if (mod && key === "s") {
    e.preventDefault();
    void (e.shiftKey ? saveAs() : saveTo(defaultFileName()));
  } else if (mod || e.altKey) {
    return;
  } else if (key === "delete" || key === "backspace") {
    e.preventDefault();
    deleteSelected();
  } else if (key === "escape") {
    select(null);
  } else if (TOOL_KEYS[key]) {
    setTool(TOOL_KEYS[key]);
  } else if (key === "enter" && selected()?.kind === "text") {
    onEditText(doc!.selectedId!);
  }
});

// ----------------------------------------------------------------- init ---

async function init() {
  buildPanels();
  setTool(tool);

  // Captures arriving while the editor is open.
  await listen<number>("capture-added", async (event) => {
    try {
      const d = await loadDoc(event.payload);
      docs.push(d);
      switchTo(d);
    } catch (e) {
      toast(`Aufnahme konnte nicht geladen werden: ${e}`, true);
    }
  });

  const ids = await invoke<number[]>("list_captures");
  for (const id of ids) {
    try {
      docs.push(await loadDoc(id));
    } catch (e) {
      toast(`Aufnahme konnte nicht geladen werden: ${e}`, true);
    }
  }
  switchTo(docs[docs.length - 1] ?? null);

  window.addEventListener("resize", () => {
    finishEditing();
    layout();
    refresh(); // hit areas depend on the display scale
    placeCropBar();
  });
  window.addEventListener("beforeunload", flushSave);
}

init().catch((e) => toast(`Editor konnte nicht starten: ${e}`, true));
