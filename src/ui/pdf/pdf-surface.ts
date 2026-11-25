/**
 * Draws a PDF into a scrolling element, one canvas per page.
 *
 * Only pages near the visible area hold a canvas; a long report would
 * otherwise need hundreds of megabytes of pixel memory. When a new version of
 * the document arrives, each page keeps showing its old picture until the new
 * one is drawn, so recompiling does not flicker and the scroll position stays.
 */
import type * as PdfjsModule from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

type Pdfjs = typeof PdfjsModule;

let pdfjsPromise: Promise<Pdfjs> | null = null;

function loadPdfjs(): Promise<Pdfjs> {
  pdfjsPromise ??= import('pdfjs-dist').then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    return pdfjs;
  });
  return pdfjsPromise;
}

export type Zoom = 'fit' | number;

export interface SurfaceInfo {
  pages: number;
  /** Size on screen relative to the printed size; 1 means 100 %. */
  scale: number;
  zoom: Zoom;
}

interface Slot {
  el: HTMLDivElement;
  /** Page size in PDF points. */
  width: number;
  height: number;
  renderedKey: string | null;
  task: RenderTask | null;
  near: boolean;
}

const CSS_PIXELS_PER_POINT = 96 / 72;
const SIDE_PADDING = 28;
const MAX_CANVAS_PIXELS = 16_000_000;
export const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

export class PdfSurface {
  readonly #scroller: HTMLElement;
  readonly #host: HTMLElement;
  readonly #onInfo: (info: SurfaceInfo) => void;
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

  /** `scroller` scrolls; the page elements are added to `host`, which lies inside it. */
  constructor(scroller: HTMLElement, host: HTMLElement, onInfo: (info: SurfaceInfo) => void) {
    this.#scroller = scroller;
    this.#host = host;
    this.#onInfo = onInfo;
    this.#observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const slot = this.#slots.find((candidate) => candidate.el === entry.target);
          if (!slot) continue;
          slot.near = entry.isIntersecting;
          if (!slot.near && slot.renderedKey !== null) {
            // Far from view: give the pixel memory back.
            slot.task?.cancel();
            slot.el.replaceChildren();
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
  async show(bytes: Uint8Array): Promise<void> {
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
        el.setAttribute('role', 'img');
        el.setAttribute('aria-label', `Page ${index + 1}`);
        slot = { el, width, height, renderedKey: null, task: null, near: false };
        this.#slots.push(slot);
        this.#host.append(el);
        this.#observer.observe(el);
      }
      slot.width = width;
      slot.height = height;
    });
    this.#layout();
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

  dispose(): void {
    this.#disposed = true;
    this.#observer.disconnect();
    this.#resize.disconnect();
    for (const slot of this.#slots) {
      slot.task?.cancel();
      slot.el.remove();
    }
    this.#slots = [];
    void this.#loading?.destroy();
    this.#loading = null;
    this.#doc = null;
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
    }
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
      slot.el.replaceChildren(canvas);
      slot.renderedKey = key;
    } catch (error) {
      slot.task = null;
      const cancelled = error instanceof Error && error.name === 'RenderingCancelledException';
      // A page that cannot be drawn is marked as done, so the loop does not retry it forever.
      if (!cancelled && this.#doc === doc) slot.renderedKey = key;
    }
  }
}
