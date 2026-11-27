/**
 * Draws a PDF into a scrolling element, one canvas per page.
 *
 * Only pages near the visible area hold a canvas; a long report would
 * otherwise need hundreds of megabytes of pixel memory. When a new version of
 * the document arrives, each page keeps showing its old picture until the new
 * one is drawn, so recompiling does not flicker and the scroll position stays.
 */
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { loadPdfjs } from './pdfjs';

export type Zoom = 'fit' | number;

/** A point on a page, in PDF points from the page's top left corner. */
export interface PagePoint {
  /** Page number, from 1. */
  page: number;
  x: number;
  y: number;
}

export interface PageRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface SurfaceInfo {
  pages: number;
  /** Size on screen relative to the printed size; 1 means 100 %. */
  scale: number;
  zoom: Zoom;
}

interface Slot {
  el: HTMLDivElement;
  /** Holds the canvas; replaced on every new drawing. */
  art: HTMLDivElement;
  /** Invisible text over the picture, so words can be selected. */
  text: HTMLDivElement | null;
  /** Comment and suggestion marks, positioned in percent of the page, so zooming needs no redraw. */
  overlay: HTMLDivElement;
  /** Page size in PDF points. */
  width: number;
  height: number;
  renderedKey: string | null;
  task: RenderTask | null;
  textTask: { cancel(): void } | null;
  near: boolean;
}

/** A comment or suggestion to mark on a page. */
export interface SurfaceMark {
  id: string;
  page: number;
  rects: PageRect[];
  kind: 'comment' | 'suggestion';
  /** Index into the review palette. */
  color: number;
  active: boolean;
}

/** What is selected in the PDF's text. */
export interface SurfaceSelection {
  page: number;
  /** The selection on its first page, in PDF points. */
  rects: PageRect[];
  text: string;
  /** Page points at the start and the end of the selection, for SyncTeX. */
  start: PagePoint;
  end: PagePoint;
  /** Where the selection ends on screen, to place a toolbar. */
  box: DOMRect;
}

/** A run of text on a page, in PDF points from the top left corner. */
export interface PageTextRun {
  str: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const CSS_PIXELS_PER_POINT = 96 / 72;
const SIDE_PADDING = 28;
const MAX_CANVAS_PIXELS = 16_000_000;
/** Screen pixels from one note in the margin to the next, so they do not overlap. */
const PIN_SPACING = 21;
export const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

export class PdfSurface {
  readonly #scroller: HTMLElement;
  readonly #host: HTMLElement;
  readonly #onInfo: (info: SurfaceInfo) => void;
  readonly #onDrawFailed: (error: unknown) => void;
  readonly #observer: IntersectionObserver;
  readonly #resize: ResizeObserver;
  #doc: PDFDocumentProxy | null = null;
  #loading: PDFDocumentLoadingTask | null = null;
  #slots: Slot[] = [];
  #zoom: Zoom = 'fit';
  #version = 0;
  #docVersion = 0;
  #pumping = false;
  #again = false;
  #disposed = false;
  #lastWidth = 0;
  #marks: SurfaceMark[] = [];
  #textCache = new Map<string, Promise<PageTextRun[]>>();
  /** Settles when the document being loaded is shown. */
  #shown: Promise<void> = Promise.resolve();

  /**
   * `scroller` scrolls; the page elements are added to `host`, which lies inside it.
   * `onDrawFailed` hears of a page that could not be drawn and stays empty.
   */
  constructor(scroller: HTMLElement, host: HTMLElement, onInfo: (info: SurfaceInfo) => void, onDrawFailed: (error: unknown) => void = () => {}) {
    this.#scroller = scroller;
    this.#host = host;
    this.#onInfo = onInfo;
    this.#onDrawFailed = onDrawFailed;
    this.#observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const slot = this.#slots.find((candidate) => candidate.el === entry.target);
          if (!slot) continue;
          slot.near = entry.isIntersecting;
          if (!slot.near && slot.renderedKey !== null) {
            // Far from view: give the pixel memory back.
            slot.task?.cancel();
            slot.textTask?.cancel();
            slot.art.replaceChildren();
            slot.text?.remove();
            slot.text = null;
            slot.renderedKey = null;
          }
        }
        void this.#pump();
      },
      { root: scroller, rootMargin: '150% 0px' },
    );
    this.#resize = new ResizeObserver(() => {
      const width = scroller.clientWidth;
      if (width === this.#lastWidth) return;
      this.#lastWidth = width;
      if (this.#zoom === 'fit') this.#layout();
    });
    this.#resize.observe(scroller);
  }

  /** Shows a new document, or a new version of the current one. */
  show(bytes: Uint8Array): Promise<void> {
    const shown = this.#show(bytes);
    this.#shown = shown.catch(() => undefined);
    return shown;
  }

  async #show(bytes: Uint8Array): Promise<void> {
    const version = ++this.#version;
    const pdfjs = await loadPdfjs();
    // pdf.js takes ownership of the buffer it is given, so it gets a copy.
    const loading = pdfjs.getDocument({ data: bytes.slice(), verbosity: pdfjs.VerbosityLevel.ERRORS });
    let doc: PDFDocumentProxy;
    const sizes: [number, number][] = [];
    try {
      doc = await loading.promise;
      for (let number = 1; number <= doc.numPages; number++) {
        const viewport = (await doc.getPage(number)).getViewport({ scale: 1 });
        sizes.push([viewport.width, viewport.height]);
      }
    } catch (error) {
      void loading.destroy();
      if (version === this.#version && !this.#disposed) throw error;
      return;
    }
    if (version !== this.#version || this.#disposed) {
      void loading.destroy();
      return;
    }

    const previous = this.#loading;
    this.#doc = doc;
    this.#loading = loading;
    this.#docVersion = version;
    this.#textCache.clear();
    for (const slot of this.#slots) slot.task?.cancel();

    while (this.#slots.length > sizes.length) {
      const slot = this.#slots.pop()!;
      this.#observer.unobserve(slot.el);
      slot.el.remove();
    }
    sizes.forEach(([width, height], index) => {
      let slot = this.#slots[index];
      if (!slot) {
        const el = document.createElement('div');
        el.className = 'pdf-page';
        el.dataset.page = String(index + 1);
        el.setAttribute('aria-label', `Page ${index + 1}`);
        const art = document.createElement('div');
        art.className = 'pdf-art';
        const overlay = document.createElement('div');
        overlay.className = 'pdf-overlay';
        el.append(art, overlay);
        slot = { el, art, text: null, overlay, width, height, renderedKey: null, task: null, textTask: null, near: false };
        this.#slots.push(slot);
        this.#host.append(el);
        this.#observer.observe(el);
      }
      slot.width = width;
      slot.height = height;
    });
    this.#layout();
    this.#drawMarks();
    void previous?.destroy();
  }

  /** Removes the document, for a project that has not produced a PDF. */
  clear(): void {
    this.#version++;
    for (const slot of this.#slots) {
      slot.task?.cancel();
      this.#observer.unobserve(slot.el);
      slot.el.remove();
    }
    this.#slots = [];
    void this.#loading?.destroy();
    this.#loading = null;
    this.#doc = null;
    this.#report();
  }

  setZoom(zoom: Zoom): void {
    if (zoom === this.#zoom) return;
    const scroller = this.#scroller;
    const ratio = scroller.scrollHeight > 0 ? scroller.scrollTop / scroller.scrollHeight : 0;
    this.#zoom = zoom;
    this.#layout();
    scroller.scrollTop = ratio * scroller.scrollHeight;
  }

  /** One step in or out from the current size. */
  step(direction: 1 | -1): void {
    const current = this.#scale() / CSS_PIXELS_PER_POINT;
    const next = direction === 1 ? ZOOM_STEPS.find((step) => step > current + 0.01) : [...ZOOM_STEPS].reverse().find((step) => step < current - 0.01);
    if (next !== undefined) this.setZoom(next);
  }

  /** The page point under a position on screen, or null outside the pages. */
  pointAt(clientX: number, clientY: number): PagePoint | null {
    const scale = this.#scale();
    for (let index = 0; index < this.#slots.length; index++) {
      const box = this.#slots[index]!.el.getBoundingClientRect();
      if (clientX < box.left || clientX > box.right || clientY < box.top || clientY > box.bottom) continue;
      return { page: index + 1, x: (clientX - box.left) / scale, y: (clientY - box.top) / scale };
    }
    return null;
  }

  /** The word printed at a page point, if any, to place the cursor on it in the source. */
  async wordAt(point: PagePoint): Promise<string | null> {
    const doc = this.#doc;
    if (!doc || point.page < 1 || point.page > doc.numPages) return null;
    try {
      const page = await doc.getPage(point.page);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (!('str' in item) || item.str.trim() === '' || item.width <= 0) continue;
        // The item's baseline start, turned into top-left page coordinates.
        const [x0, y0] = viewport.convertToViewportPoint(item.transform[4] as number, item.transform[5] as number) as [number, number];
        const height = Math.max(item.height, Math.hypot(item.transform[2] as number, item.transform[3] as number));
        if (point.x < x0 || point.x > x0 + item.width || point.y < y0 - height || point.y > y0 + height * 0.3) continue;
        // Glyph widths are not known here; the share of the width is close enough to find the word.
        const at = Math.min(item.str.length - 1, Math.floor(((point.x - x0) / item.width) * item.str.length));
        return wordAround(item.str, at);
      }
    } catch {
      // A page that cannot be read only loses the word, not the jump.
    }
    return null;
  }

  /** Scrolls a page point into view and marks the given areas for a moment. */
  reveal(page: number, rects: PageRect[]): void {
    const slot = this.#slots[page - 1];
    if (!slot) return;
    const scale = this.#scale();
    const top = rects.length > 0 ? Math.min(...rects.map((rect) => rect.top)) : 0;
    const bottom = rects.length > 0 ? Math.max(...rects.map((rect) => rect.bottom)) : 0;
    const scroller = this.#scroller;
    const pageTop = slot.el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const middle = pageTop + ((top + bottom) / 2) * scale;
    const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    scroller.scrollTo({ top: Math.max(0, middle - scroller.clientHeight / 2), behavior: smooth ? 'smooth' : 'auto' });

    for (const old of this.#host.querySelectorAll('.pdf-mark')) old.remove();
    for (const rect of rects) {
      const mark = document.createElement('div');
      mark.className = 'pdf-mark';
      mark.style.left = `${(rect.left - 2) * scale}px`;
      mark.style.top = `${(rect.top - 1) * scale}px`;
      mark.style.width = `${(rect.right - rect.left + 4) * scale}px`;
      mark.style.height = `${(rect.bottom - rect.top + 2) * scale}px`;
      slot.el.append(mark);
      mark.addEventListener('animationend', () => mark.remove());
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#observer.disconnect();
    this.#resize.disconnect();
    for (const slot of this.#slots) {
      slot.task?.cancel();
      slot.textTask?.cancel();
      slot.el.remove();
    }
    this.#slots = [];
    void this.#loading?.destroy();
    this.#loading = null;
    this.#doc = null;
  }

  // ---- text, selection and review marks ------------------------------------------

  /** The text runs of a page with their places, read once per version of the document. */
  async pageText(page: number): Promise<PageTextRun[]> {
    // A document still loading is waited for, so marks are not placed on an empty page.
    await this.#shown;
    const doc = this.#doc;
    if (!doc || page < 1 || page > doc.numPages) return Promise.resolve([]);
    const key = `${this.#docVersion}:${page}`;
    let cached = this.#textCache.get(key);
    if (!cached) {
      cached = (async () => {
        const proxy = await doc.getPage(page);
        const viewport = proxy.getViewport({ scale: 1 });
        const content = await proxy.getTextContent();
        const runs: PageTextRun[] = [];
        for (const item of content.items) {
          if (!('str' in item) || item.str === '' || item.width <= 0) continue;
          const [x0, y0] = viewport.convertToViewportPoint(item.transform[4] as number, item.transform[5] as number) as [number, number];
          const height = Math.max(item.height, Math.hypot(item.transform[2] as number, item.transform[3] as number));
          runs.push({ str: item.str, left: x0, top: y0 - height * 0.85, right: x0 + item.width, bottom: y0 + height * 0.25 });
        }
        return runs;
      })().catch(() => []);
      this.#textCache.set(key, cached);
    }
    return cached;
  }

  /** Shows these marks, replacing the ones shown before. */
  setMarks(marks: SurfaceMark[]): void {
    this.#marks = marks;
    this.#drawMarks();
  }

  /** The mark under a point on screen, if any; the active one wins. */
  markAt(clientX: number, clientY: number): string | null {
    const point = this.pointAt(clientX, clientY);
    if (!point) return null;
    const hits = this.#marks.filter(
      (mark) => mark.page === point.page && mark.rects.some((rect) => point.x >= rect.left - 1 && point.x <= rect.right + 1 && point.y >= rect.top - 1 && point.y <= rect.bottom + 1),
    );
    return (hits.find((mark) => mark.active) ?? hits[0])?.id ?? null;
  }

  /** Where a mark is on screen now, to place a card next to it. */
  markBox(id: string): DOMRect | null {
    const element = this.#host.querySelector<HTMLElement>(`.pdf-rv[data-thread="${CSS.escape(id)}"]`);
    return element?.getBoundingClientRect() ?? null;
  }

  /** Scrolls a mark into view, without the flash `reveal` makes. */
  scrollToMark(id: string): boolean {
    const mark = this.#marks.find((candidate) => candidate.id === id);
    const slot = mark ? this.#slots[mark.page - 1] : undefined;
    if (!mark || !slot || mark.rects.length === 0) return false;
    const scale = this.#scale();
    const top = Math.min(...mark.rects.map((rect) => rect.top));
    const scroller = this.#scroller;
    const pageTop = slot.el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    scroller.scrollTo({ top: Math.max(0, pageTop + top * scale - scroller.clientHeight / 3), behavior: smooth ? 'smooth' : 'auto' });
    return true;
  }

  /** The current text selection inside the pages, or null. */
  selection(): SurfaceSelection | null {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (!this.#host.contains(range.commonAncestorContainer)) return null;
    const text = selection.toString();
    if (text.trim() === '') return null;
    const clientRects = [...range.getClientRects()].filter((rect) => rect.width > 0.5 && rect.height > 0.5);
    if (clientRects.length === 0) return null;
    const first = clientRects[0]!;
    const last = clientRects.at(-1)!;
    const start = this.pointAt(first.left + 1, first.top + first.height / 2);
    const end = this.pointAt(last.right - 1, last.top + last.height / 2);
    if (!start || !end) return null;
    const slot = this.#slots[start.page - 1]!;
    const box = slot.el.getBoundingClientRect();
    const scale = this.#scale();
    const rects = mergeLines(
      clientRects
        .filter((rect) => rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1)
        .map((rect) => ({ left: (rect.left - box.left) / scale, top: (rect.top - box.top) / scale, right: (rect.right - box.left) / scale, bottom: (rect.bottom - box.top) / scale })),
    );
    return { page: start.page, rects, text, start, end, box: last };
  }

  #drawMarks(): void {
    for (const slot of this.#slots) slot.overlay.replaceChildren();
    const scale = this.#scale();
    // Notes in the margin that would overlap move down below the one above them.
    const pinBottoms = new Map<number, number>();
    const ordered = [...this.#marks].sort((a, b) => a.page - b.page || (a.rects[0]?.top ?? 0) - (b.rects[0]?.top ?? 0));
    for (const mark of ordered) {
      const slot = this.#slots[mark.page - 1];
      if (!slot) continue;
      mark.rects.forEach((rect, position) => {
        const element = document.createElement('div');
        element.className = `pdf-rv ${mark.kind}${mark.active ? ' active' : ''}`;
        element.dataset.thread = mark.id;
        element.style.setProperty('--rv', `var(--rv-${mark.color})`);
        element.style.left = `${((rect.left - 1) / slot.width) * 100}%`;
        element.style.top = `${((rect.top - 1) / slot.height) * 100}%`;
        element.style.width = `${((rect.right - rect.left + 2) / slot.width) * 100}%`;
        element.style.height = `${((rect.bottom - rect.top + 2) / slot.height) * 100}%`;
        if (position === 0) element.classList.add('first');
        slot.overlay.append(element);
      });
      // A small badge in the margin next to the first line, like a note in the margin of paper.
      const first = mark.rects[0];
      if (first) {
        const pin = document.createElement('div');
        pin.className = `pdf-rv-pin ${mark.kind}${mark.active ? ' active' : ''}`;
        pin.dataset.thread = mark.id;
        pin.style.setProperty('--rv', `var(--rv-${mark.color})`);
        const top = Math.max(first.top, pinBottoms.get(mark.page) ?? -Infinity);
        pinBottoms.set(mark.page, top + PIN_SPACING / scale);
        pin.style.top = `${(top / slot.height) * 100}%`;
        slot.overlay.append(pin);
      }
    }
  }

  /** CSS pixels per PDF point. */
  #scale(): number {
    if (this.#zoom !== 'fit') return this.#zoom * CSS_PIXELS_PER_POINT;
    const widest = this.#slots.reduce((max, slot) => Math.max(max, slot.width), 0);
    const available = this.#scroller.clientWidth - SIDE_PADDING;
    if (widest === 0 || available <= 0) return CSS_PIXELS_PER_POINT;
    return Math.max(0.2, Math.min(available / widest, 4 * CSS_PIXELS_PER_POINT));
  }

  #key(): string {
    return `${this.#docVersion}:${this.#scale().toFixed(4)}:${window.devicePixelRatio}`;
  }

  #layout(): void {
    const scale = this.#scale();
    for (const slot of this.#slots) {
      slot.el.style.width = `${Math.floor(slot.width * scale)}px`;
      slot.el.style.height = `${Math.floor(slot.height * scale)}px`;
      // pdf.js sizes its text layer from this.
      slot.el.style.setProperty('--total-scale-factor', String(scale));
    }
    // How far apart the notes in the margin must be depends on the zoom.
    if (this.#marks.length > 0) this.#drawMarks();
    this.#report();
    void this.#pump();
  }

  #report(): void {
    this.#onInfo({ pages: this.#slots.length, scale: this.#scale() / CSS_PIXELS_PER_POINT, zoom: this.#zoom });
  }

  /** Draws the pages near the visible area whose picture is missing or out of date, one after the other. */
  async #pump(): Promise<void> {
    if (this.#pumping) {
      this.#again = true;
      return;
    }
    this.#pumping = true;
    try {
      for (;;) {
        this.#again = false;
        const doc = this.#doc;
        if (!doc || this.#disposed) break;
        const key = this.#key();
        const index = this.#slots.findIndex((slot) => slot.near && slot.renderedKey !== key);
        if (index === -1) {
          if (this.#again) continue;
          break;
        }
        await this.#draw(doc, index, key);
      }
    } finally {
      this.#pumping = false;
    }
  }

  async #draw(doc: PDFDocumentProxy, index: number, key: string): Promise<void> {
    const slot = this.#slots[index];
    if (!slot) return;
    try {
      const page = await doc.getPage(index + 1);
      let scale = this.#scale() * window.devicePixelRatio;
      const pixels = slot.width * slot.height * scale * scale;
      if (pixels > MAX_CANVAS_PIXELS) scale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const task = page.render({ canvas, viewport });
      slot.task = task;
      await task.promise;
      if (slot.task === task) slot.task = null;
      if (this.#doc !== doc || this.#slots[index] !== slot || this.#disposed) return;
      slot.art.replaceChildren(canvas);
      slot.renderedKey = key;
      void this.#drawText(doc, slot, page, key);
    } catch (error) {
      slot.task = null;
      const cancelled = error instanceof Error && error.name === 'RenderingCancelledException';
      // A page that cannot be drawn is marked as done, so the loop does not retry it forever.
      if (!cancelled && this.#doc === doc) {
        slot.renderedKey = key;
        this.#onDrawFailed(error);
      }
    }
  }

  /** Lays the page's text over the picture, invisible, so it can be selected like in a PDF reader. */
  async #drawText(doc: PDFDocumentProxy, slot: Slot, page: Awaited<ReturnType<PDFDocumentProxy['getPage']>>, key: string): Promise<void> {
    slot.textTask?.cancel();
    try {
      const pdfjs = await loadPdfjs();
      const container = document.createElement('div');
      container.className = 'textLayer';
      const layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container, viewport: page.getViewport({ scale: this.#scale() }) });
      slot.textTask = layer;
      await layer.render();
      if (slot.textTask === layer) slot.textTask = null;
      if (this.#doc !== doc || slot.renderedKey !== key || this.#disposed) return;
      // While a selection is being made, this covers the gaps between the lines (see review.css).
      const end = document.createElement('div');
      end.className = 'endOfContent';
      container.append(end);
      container.addEventListener('mousedown', () => {
        container.classList.add('selecting');
        window.addEventListener('mouseup', () => container.classList.remove('selecting'), { once: true });
      });
      // A selection being made must not be lost because a page was redrawn.
      if (slot.text && window.getSelection()?.containsNode(slot.text, true)) return;
      slot.text?.remove();
      slot.text = container;
      slot.art.after(container);
    } catch {
      // Without its text layer a page can still be read; it just cannot be selected.
    }
  }
}

/** Joins rectangles that lie on the same line. */
function mergeLines(rects: PageRect[]): PageRect[] {
  const out: PageRect[] = [];
  for (const rect of [...rects].sort((a, b) => a.top - b.top || a.left - b.left)) {
    const last = out.at(-1);
    if (last && Math.abs(last.top - rect.top) < (rect.bottom - rect.top) * 0.5) {
      last.left = Math.min(last.left, rect.left);
      last.right = Math.max(last.right, rect.right);
      last.bottom = Math.max(last.bottom, rect.bottom);
    } else {
      out.push({ ...rect });
    }
  }
  return out;
}

/** The word of `text` around index `at`, without surrounding punctuation. */
export function wordAround(text: string, at: number): string | null {
  const isWord = (char: string | undefined): boolean => char !== undefined && /[\p{L}\p{N}_-]/u.test(char);
  let index = Math.max(0, Math.min(at, text.length - 1));
  if (!isWord(text[index])) {
    // Between two words: take the nearer one.
    let left = index;
    let right = index;
    while (left >= 0 && !isWord(text[left])) left--;
    while (right < text.length && !isWord(text[right])) right++;
    if (left < 0 && right >= text.length) return null;
    index = left < 0 || (right < text.length && right - index <= index - left) ? right : left;
  }
  let start = index;
  let end = index + 1;
  while (start > 0 && isWord(text[start - 1])) start--;
  while (end < text.length && isWord(text[end])) end++;
  const word = text.slice(start, end).replace(/^-+|-+$/g, '');
  return word.length >= 2 ? word : null;
}
