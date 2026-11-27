// Editor controller: owns the state, wires toolbar, keyboard and canvas.

import { invoke } from "@tauri-apps/api/core";
import { LogicalSize, getCurrentWindow } from "@tauri-apps/api/window";
import { save } from "@tauri-apps/plugin-dialog";
import { storedImageUrl } from "../images";
import { AnnotationCanvas, FONT_FAMILY, TEXT_LINE_HEIGHT, textPadding, type Point } from "./canvas";
import { History } from "./history";
import {
  type Annotation,
  type HeadPosition,
  type HeadStyle,
  type Kind,
  type Size,
  type Style,
  type TextNote,
  COLORS,
  DEFAULT_STYLE,
  MAGNIFIER_COLOR,
  defaultMagnifierRadius,
  fontSize,
  newId,
  nextMarkerLabel,
  styleFor,
  translate,
} from "./model";

type Tool = "select" | Kind;

const IS_MAC = navigator.userAgent.includes("Mac");
const STAGE_MARGIN = 24;
const MIN_WINDOW_HEIGHT = 360;
const PATH_HEADER = "x-pasta-path";

const history = new History<readonly Annotation[]>([]);
let selectedId: string | null = null;
let tool: Tool = "marker";
let style: Style = { ...DEFAULT_STYLE };
let editing: { draft: TextNote; isNew: boolean; textarea: HTMLTextAreaElement } | null = null;
let canvas: AnnotationCanvas;

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const stageArea = $<HTMLElement>("#stage-area");
const stageEl = $<HTMLDivElement>("#stage");

// ---------------------------------------------------------------- state ---

function annotations(): readonly Annotation[] {
  return history.present;
}

function selected(): Annotation | undefined {
  return annotations().find((a) => a.id === selectedId);
}

function commit(next: readonly Annotation[]) {
  history.push(next);
  refresh();
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
  if (selectedId && !selected()) selectedId = null;
  canvas.render(annotations(), selectedId, editing?.isNew ? undefined : editing?.draft.id);
  updateToolbar();
}

function select(id: string | null) {
  selectedId = id;
  const a = selected();
  if (a) style = { ...style, ...styleFor(a.kind, a as Partial<Style>) };
  refresh();
}

function setTool(next: Tool) {
  tool = next;
  stageEl.className = `tool-${tool}`;
  updateArrowTemplate();
  updateToolbar();
}

/** Applies a style change to the defaults and to the selected annotation. */
function setStyle(change: Partial<Style>) {
  style = { ...style, ...change };
  updateArrowTemplate();

  const a = selected();
  const relevant = a ? styleFor(a.kind, change) : {};
  if (a && Object.keys(relevant).length > 0) {
    update(a.id, relevant);
  } else {
    updateToolbar();
  }
}

function updateArrowTemplate() {
  canvas.arrowTemplate =
    tool === "arrow"
      ? { color: style.color, size: style.size, heads: style.heads, headStyle: style.headStyle }
      : null;
}

/** Kind whose options the toolbar shows: the selection, else the tool. */
function contextKind(): Kind | "none" {
  return selected()?.kind ?? (tool === "select" ? "none" : tool);
}

function deleteSelected() {
  if (!selectedId) return;
  commit(annotations().filter((a) => a.id !== selectedId));
}

function undo() {
  history.undo();
  refresh();
}

function redo() {
  history.redo();
  refresh();
}

// --------------------------------------------------------------- canvas ---

function onBackgroundClick(p: Point) {
  const { color, size } = style;
  if (tool === "marker") {
    commit([
      ...annotations(),
      { kind: "marker", id: newId(), x: p.x, y: p.y, color, size, label: nextMarkerLabel(annotations()) },
    ]);
  } else if (tool === "text") {
    if (selectedId) select(null);
    startEditing({ kind: "text", id: newId(), x: p.x, y: p.y, color, size, boxed: style.boxed, text: "" }, true);
  } else if (tool === "magnifier") {
    const id = newId();
    selectedId = id;
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
  // Arrow tool: arrows are created by dragging (onDrawArrow).
}

function onDrawArrow(start: Point, end: Point) {
  const id = newId();
  selectedId = id;
  commit([
    ...annotations(),
    {
      kind: "arrow",
      id,
      x: start.x,
      y: start.y,
      x2: end.x,
      y2: end.y,
      color: style.color,
      size: style.size,
      heads: style.heads,
      headStyle: style.headStyle,
    },
  ]);
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
  canvas.fit(stageArea.clientWidth - 2 * STAGE_MARGIN, stageArea.clientHeight - 2 * STAGE_MARGIN);
}

// --------------------------------------------------------- text editing ---

function startEditing(draft: TextNote, isNew: boolean) {
  if (editing) finishEditing();

  const textarea = document.createElement("textarea");
  textarea.className = "text-editor";
  textarea.value = draft.text;
  textarea.spellcheck = true;
  editing = { draft, isNew, textarea };

  const scale = canvas.viewScale;
  const stageRect = stageEl.getBoundingClientRect();
  const fs = fontSize(draft.size, canvas.pixelRatio) * scale;
  const pad = textPadding(draft, canvas.pixelRatio) * scale;
  Object.assign(textarea.style, {
    left: `${stageRect.left + draft.x * scale - 1}px`,
    top: `${stageRect.top + draft.y * scale - 1}px`,
    font: `${fs}px ${FONT_FAMILY}`,
    lineHeight: String(TEXT_LINE_HEIGHT),
    padding: `${pad}px`,
    color: draft.color,
    background: draft.boxed ? "#ffffff" : "",
  });

  const autosize = () => {
    textarea.style.width = "0";
    textarea.style.height = "0";
    textarea.style.width = `${textarea.scrollWidth}px`;
    textarea.style.height = `${textarea.scrollHeight}px`;
  };
  textarea.addEventListener("input", autosize);
  textarea.addEventListener("blur", () => finishEditing());
  textarea.addEventListener("keydown", (e) => {
    e.stopPropagation();
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

function finishEditing() {
  if (!editing) return;
  const { draft, isNew, textarea } = editing;
  editing = null;
  textarea.remove();

  const text = textarea.value.replace(/\s+$/, "");
  if (isNew) {
    if (text) {
      selectedId = draft.id;
      commit([...annotations(), { ...draft, text }]);
    } else {
      refresh();
    }
  } else if (!text) {
    commit(annotations().filter((a) => a.id !== draft.id));
  } else if (text !== draft.text) {
    update(draft.id, { text });
  } else {
    refresh();
  }
}

// --------------------------------------------------------------- output ---

async function renderPng(): Promise<Uint8Array> {
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

// -------------------------------------------------------------- toolbar ---

function buildToolbar() {
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

  document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((b) =>
    b.addEventListener("click", () => setTool(b.dataset.tool as Tool)),
  );
  document.querySelectorAll<HTMLButtonElement>("[data-color]").forEach((b) =>
    b.addEventListener("click", () => setStyle({ color: b.dataset.color })),
  );
  document.querySelectorAll<HTMLButtonElement>("[data-size]").forEach((b) =>
    b.addEventListener("click", () => setStyle({ size: b.dataset.size as Size })),
  );
  document.querySelectorAll<HTMLButtonElement>("[data-heads]").forEach((b) =>
    b.addEventListener("click", () => setStyle({ heads: b.dataset.heads as HeadPosition })),
  );
  document.querySelectorAll<HTMLButtonElement>("[data-head-style]").forEach((b) =>
    b.addEventListener("click", () => setStyle({ headStyle: b.dataset.headStyle as HeadStyle })),
  );
  document.querySelectorAll<HTMLButtonElement>("[data-zoom]").forEach((b) =>
    b.addEventListener("click", () => setStyle({ zoom: Number(b.dataset.zoom) })),
  );
  $<HTMLInputElement>("#boxed").addEventListener("change", (e) =>
    setStyle({ boxed: (e.target as HTMLInputElement).checked }),
  );
  $<HTMLInputElement>("#blur-outside").addEventListener("change", (e) =>
    setStyle({ blurOutside: (e.target as HTMLInputElement).checked }),
  );
  $("#undo").addEventListener("click", undo);
  $("#redo").addEventListener("click", redo);
  $("#copy").addEventListener("click", () => void copyToClipboard());
  $("#save").addEventListener("click", () => void saveTo(defaultFileName()));
  $("#save-as").addEventListener("click", () => void saveAs());

  // Buttons must not steal keyboard focus from the editor shortcuts.
  document.querySelectorAll("button").forEach((b) => b.addEventListener("mousedown", (e) => e.preventDefault()));

  if (!IS_MAC) {
    document.querySelectorAll<HTMLElement>("[title]").forEach((el) => {
      el.title = el.title.replace("⇧⌘", "Strg+Umschalt+").replace("⌘", "Strg+");
    });
  }
}

function updateToolbar() {
  const check = (selector: string, isOn: (el: HTMLElement) => boolean) =>
    document.querySelectorAll<HTMLElement>(selector).forEach((el) => {
      el.setAttribute("role", "radio");
      el.setAttribute("aria-checked", String(isOn(el)));
    });
  check("[data-tool]", (el) => el.dataset.tool === tool);
  check("[data-color]", (el) => el.dataset.color === style.color);
  check("[data-size]", (el) => el.dataset.size === style.size);
  check("[data-heads]", (el) => el.dataset.heads === style.heads);
  check("[data-head-style]", (el) => el.dataset.headStyle === style.headStyle);
  check("[data-zoom]", (el) => Number(el.dataset.zoom) === style.zoom);
  $<HTMLInputElement>("#boxed").checked = style.boxed;
  $<HTMLInputElement>("#blur-outside").checked = style.blurOutside;

  const kind = contextKind();
  document.querySelectorAll<HTMLElement>("[data-for]").forEach((el) => {
    el.hidden = !el.dataset.for!.split(" ").includes(kind);
  });
  $<HTMLButtonElement>("#undo").disabled = !history.canUndo;
  $<HTMLButtonElement>("#redo").disabled = !history.canRedo;
}

/**
 * Widens the window so the toolbar fits for every tool, and makes that the
 * minimum width. The toolbar's options vary by tool, so measure each variant.
 */
async function fitWindowToToolbar() {
  const toolbar = $<HTMLElement>("#toolbar");
  const contextual = [...document.querySelectorAll<HTMLElement>("[data-for]")];
  const kinds = new Set(contextual.flatMap((el) => el.dataset.for!.split(" ")));

  let needed = 0;
  for (const kind of kinds) {
    for (const el of contextual) el.hidden = !el.dataset.for!.split(" ").includes(kind);
    needed = Math.max(needed, toolbar.scrollWidth);
  }
  updateToolbar();

  const win = getCurrentWindow();
  await win.setMinSize(new LogicalSize(needed, MIN_WINDOW_HEIGHT));
  if (window.innerWidth < needed) {
    await win.setSize(new LogicalSize(needed, window.innerHeight));
  }
}

// ------------------------------------------------------------- keyboard ---

window.addEventListener("keydown", (e) => {
  if (editing) return;
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
  } else if (key === "v") {
    setTool("select");
  } else if (key === "n") {
    setTool("marker");
  } else if (key === "t") {
    setTool("text");
  } else if (key === "a") {
    setTool("arrow");
  } else if (key === "l") {
    setTool("magnifier");
  } else if (key === "enter" && selected()?.kind === "text") {
    onEditText(selectedId!);
  }
});

// ----------------------------------------------------------------- init ---

async function init() {
  const id = getCurrentWindow().label.replace(/^editor-/, "");
  const image = new Image();
  image.crossOrigin = "anonymous"; // keeps the canvas exportable
  image.src = storedImageUrl(`capture-${id}.png`);
  await image.decode();

  canvas = new AnnotationCanvas(stageEl, image, window.devicePixelRatio, {
    onBackgroundClick,
    onSelect: select,
    onTranslate,
    onUpdate: update,
    onEditText,
    onDrawArrow,
  });

  buildToolbar();
  setTool(tool);
  layout();
  refresh();
  await fitWindowToToolbar();
  window.addEventListener("resize", () => {
    finishEditing();
    layout();
  });
}

init().catch((e) => toast(`Bild konnte nicht geladen werden: ${e}`, true));
