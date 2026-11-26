/**
 * Reads SyncTeX data and answers the two questions an editor asks of it:
 *
 *  - inverse search: which file and line produced this point of the PDF?
 *  - forward search: where in the PDF did this line of this file end up?
 *
 * Written from the documented text format of uncompressed `.synctex` files
 * (pdfTeX `--synctex=-1`). Coordinates in the file are TeX scaled points
 * measured from the top left corner of the page, with `v` on the baseline;
 * everything this module returns is in PDF points from the top left corner.
 *
 * Pure functions, no I/O.
 */
import type { Path } from '../types';
import { PathResolver } from './log';

export interface SyncRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A position TeX recorded inside a line: a glyph run, a kern, glue or math. */
interface SyncRecord {
  /** The record type: x (glyphs), k (kern), g (glue), $ (math) or h (empty box). */
  kind: string;
  tag: number;
  line: number;
  h: number;
  v: number;
  /** Width of a kern, in PDF points; 0 for the other kinds. */
  width: number;
  /**
   * Part of the fill that ends a paragraph. TeX files it under the source
   * line that ended the paragraph (a blank line, \begin{itemize}), which
   * printed nothing there.
   */
  fill: boolean;
}

/** An horizontal box: a line of text, or a box inside one. */
interface SyncBox extends SyncRect {
  tag: number;
  line: number;
  /** Positions recorded directly inside this box, left to right as TeX wrote them. */
  records: SyncRecord[];
  /** Nesting depth on the page; deeper boxes are more specific. */
  depth: number;
}

interface SyncPage {
  number: number;
  boxes: SyncBox[];
}

export interface SyncTexMap {
  /** Project file of each input tag, or null for files outside the project (packages, the .aux file). */
  files: Map<number, Path | null>;
  pages: SyncPage[];
}

export interface SourceSpot {
  file: Path;
  line: number;
}

export interface PdfSpot {
  /** Page number, from 1. */
  page: number;
  /** Lines of the PDF that came from the source line, on that page. */
  rects: SyncRect[];
}

/** TeX points per PDF point, and scaled points per TeX point. */
const BP_PER_SP = 72 / 72.27 / 65536;
/** Half the height given to boxes TeX recorded without height or depth, in PDF points. */
const FLAT_BOX_SLACK = 3;
/** A kern wider than this, in PDF points, is the fill that ends a paragraph, not a space. */
const PARAGRAPH_FILL = 12;
/** How far from a line a click may land and still count as being on it, in PDF points. */
const NEAR_LINE = 14;

export interface ParseOptions {
  /** Every path of the project, used to map SyncTeX file names to project files. */
  knownPaths: Iterable<Path>;
  /** Folder of the main file: TeX ran there, so relative names start there. */
  workDir?: Path;
}

export function parseSyncTex(text: string, options: ParseOptions): SyncTexMap {
  const resolver = new PathResolver(options.knownPaths, options.workDir ?? '');
  const files = new Map<number, Path | null>();
  const pages: SyncPage[] = [];
  let unit = 1;
  let magnification = 1000;
  let xOffset = 0;
  let yOffset = 0;
  let scale = BP_PER_SP;
  let inContent = false;

  let page: SyncPage | null = null;
  // Open boxes; null marks a vertical box, which holds no records of its own.
  const stack: (SyncBox | null)[] = [];
  let hboxDepth = 0;

  const toX = (sp: number): number => (sp * unit + xOffset) * scale;
  const toY = (sp: number): number => (sp * unit + yOffset) * scale;

  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line === '') continue;

    if (line.startsWith('Input:')) {
      const match = /^Input:(\d+):(.*)$/.exec(line);
      if (match) files.set(Number(match[1]), resolveInput(resolver, match[2]!));
      continue;
    }
    if (!inContent) {
      const header = /^([A-Za-z ]+):\s*(-?[\d.]+)/.exec(line);
      if (header) {
        const value = Number(header[2]);
        if (header[1] === 'Unit') unit = value || 1;
        else if (header[1] === 'Magnification') magnification = value || 1000;
        else if (header[1] === 'X Offset') xOffset = value;
        else if (header[1] === 'Y Offset') yOffset = value;
      }
      if (line.startsWith('Content:')) {
        inContent = true;
        scale = (BP_PER_SP * magnification) / 1000;
      }
      continue;
    }
    if (line.startsWith('Postamble:')) break;

    const kind = line[0];
    if (kind === '{') {
      page = { number: Number(line.slice(1)) || pages.length + 1, boxes: [] };
      pages.push(page);
      stack.length = 0;
      hboxDepth = 0;
      continue;
    }
    if (kind === '}') {
      page = null;
      continue;
    }
    if (!page) continue;

    if (kind === ']' || kind === ')') {
      const closed = stack.pop();
      if (closed) hboxDepth--;
      continue;
    }

    const fields = parseFields(line.slice(1));
    if (!fields) {
      if (kind === '[' || kind === '(') stack.push(null); // keep the nesting right even for a line we cannot read
      continue;
    }
    const { tag, line: sourceLine, h, v, width, height, depth } = fields;

    if (kind === '[') {
      stack.push(null);
    } else if (kind === '(' || kind === 'h') {
      const left = toX(h);
      const baseline = toY(v);
      let top = baseline - height * unit * scale;
      let bottom = baseline + depth * unit * scale;
      if (bottom - top < 2 * FLAT_BOX_SLACK) {
        top = Math.min(top, baseline - FLAT_BOX_SLACK);
        bottom = Math.max(bottom, baseline + FLAT_BOX_SLACK);
      }
      const box: SyncBox = { tag, line: sourceLine, left, right: left + width * unit * scale, top, bottom, records: [], depth: hboxDepth + 1 };
      page.boxes.push(box);
      // A void box is also an item of the line it sits in.
      if (kind === 'h') innermostBox(stack)?.records.push({ kind, tag, line: sourceLine, h: left, v: baseline, width: 0, fill: false });
      else {
        stack.push(box);
        hboxDepth++;
      }
    } else if (kind === 'x' || kind === 'k' || kind === 'g' || kind === '$') {
      const owner = innermostBox(stack);
      if (owner) {
        const record: SyncRecord = { kind, tag, line: sourceLine, h: toX(h), v: toY(v), width: kind === 'k' ? width * unit * scale : 0, fill: false };
        const previous = owner.records[owner.records.length - 1];
        record.fill = (kind === 'k' && record.width > PARAGRAPH_FILL) || (kind === 'g' && previous !== undefined && previous.fill && Math.abs(previous.h - record.h) < 0.01);
        owner.records.push(record);
      }
    }
    // 'v' (void vertical box), 'f' and form markers carry nothing a click can land on.
  }
  return { files, pages };
}

/** Which file and line made the point (`x`, `y`) of `page`, in PDF points from the top left. */
export function inverseSearch(map: SyncTexMap, page: number, x: number, y: number): SourceSpot | null {
  const boxes = map.pages.find((candidate) => candidate.number === page)?.boxes ?? [];
  const inProject = (tag: number): Path | null => map.files.get(tag) ?? null;

  // The most specific boxes first: deepest, then smallest.
  const containing = boxes
    .filter((box) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom)
    .sort((a, b) => b.depth - a.depth || area(a) - area(b));
  for (const box of containing) {
    const spot = spotInBox(box, x, inProject);
    if (spot) return spot;
  }

  // Between lines or in a margin: the line closest to the point.
  let best: { box: SyncBox; distance: number } | null = null;
  for (const box of boxes) {
    if (box.records.length === 0 && !inProject(box.tag)) continue;
    const dx = x < box.left ? box.left - x : x > box.right ? x - box.right : 0;
    const dy = y < box.top ? box.top - y : y > box.bottom ? y - box.bottom : 0;
    const distance = Math.hypot(dx * 0.5, dy);
    if (!best || distance < best.distance) best = { box, distance };
  }
  if (best && best.distance <= NEAR_LINE * 4) return spotInBox(best.box, x, inProject);
  return null;
}

/** Where `line` of `file` was typeset. Lines that made no output fall to the next line that did. */
export function forwardSearch(map: SyncTexMap, file: Path, line: number): PdfSpot | null {
  const tags = new Set<number>();
  for (const [tag, path] of map.files) if (path === file) tags.add(tag);
  if (tags.size === 0) return null;

  // Every source line of this file that left a trace, with the boxes it lies in.
  const hits = new Map<number, { page: number; box: SyncBox }[]>();
  const add = (sourceLine: number, pageNumber: number, box: SyncBox): void => {
    const list = hits.get(sourceLine) ?? [];
    list.push({ page: pageNumber, box });
    hits.set(sourceLine, list);
  };
  for (const page of map.pages) {
    for (const box of page.boxes) {
      box.records.forEach((record, index) => {
        // The glyph record that opens a printed line carries the line that ended the paragraph, not its own.
        if (record.fill || (index === 0 && record.kind === 'x') || !tags.has(record.tag)) return;
        add(record.line, page.number, box);
      });
      if (tags.has(box.tag) && box.records.length === 0) add(box.line, page.number, box);
    }
  }
  if (hits.size === 0) return null;

  const lines = [...hits.keys()].sort((a, b) => a - b);
  const chosen = lines.find((candidate) => candidate >= line) ?? lines[lines.length - 1]!;
  const found = hits.get(chosen)!;
  // A line can leave stray traces where it ended the previous page (\chapter
  // ships the page before it). The page with most of its output is the one.
  const perPage = new Map<number, number>();
  for (const { page } of found) perPage.set(page, (perPage.get(page) ?? 0) + 1);
  const pageNumber = [...perPage].reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0];
  const rects: SyncRect[] = [];
  for (const { page, box } of found) {
    if (page !== pageNumber) continue;
    // Report whole lines: the outermost box around each hit.
    const outer = outermostAt(map, pageNumber, box);
    if (!rects.some((rect) => sameRect(rect, outer))) rects.push(outer);
  }
  return { page: pageNumber, rects };
}

function spotInBox(box: SyncBox, x: number, inProject: (tag: number) => Path | null): SourceSpot | null {
  const records = box.records.filter((record) => inProject(record.tag));
  if (records.length > 0) {
    // A kern or glue record sits where that space ends, so the word under the
    // point is described by the first such record to its right: the space
    // that followed the word, which TeX read on the word's own line. Glyph
    // records ("x") are tagged less reliably and only serve as a fallback.
    const spaces = records.filter((record) => record.kind !== 'x');
    const pool = spaces.length > 0 ? spaces : records;
    let chosen: SyncRecord | null = null;
    for (const record of pool) if (record.h >= x - 0.5 && (!chosen || record.h < chosen.h)) chosen = record;
    if (chosen?.fill) {
      // The fill after the last line of a paragraph belongs to the source line
      // after it. The last word is better told by the glyph record where it ends.
      const before = records.filter((record) => record.kind === 'x' && record.h < chosen!.h - 0.01 && record !== records[0]);
      const last = before.reduce<SyncRecord | null>((a, b) => (!a || b.h >= a.h ? b : a), null);
      if (last && last.h >= x - 40) chosen = last;
    }
    chosen ??= pool.reduce((a, b) => (b.h > a.h ? b : a));
    return { file: inProject(chosen.tag)!, line: chosen.line };
  }
  const file = inProject(box.tag);
  return file ? { file, line: box.line } : null;
}

function outermostAt(map: SyncTexMap, pageNumber: number, box: SyncBox): SyncRect {
  const boxes = map.pages.find((page) => page.number === pageNumber)?.boxes ?? [];
  let outer: SyncRect = box;
  for (const candidate of boxes) {
    if (candidate.depth >= box.depth) continue;
    const midY = (box.top + box.bottom) / 2;
    if (candidate.left <= box.left + 0.5 && candidate.right >= box.right - 0.5 && candidate.top <= midY && candidate.bottom >= midY) {
      if (area(candidate) > area(outer)) outer = candidate;
    }
  }
  return { left: outer.left, top: outer.top, right: outer.right, bottom: outer.bottom };
}

function innermostBox(stack: (SyncBox | null)[]): SyncBox | null {
  const last = stack[stack.length - 1];
  return last ?? null;
}

function parseFields(rest: string): { tag: number; line: number; h: number; v: number; width: number; height: number; depth: number } | null {
  // tag,line[,column]:h,v[:W[,H,D]]
  const match = /^(\d+),(-?\d+)(?:,-?\d+)?:(-?\d+),(-?\d+)(?::(-?\d+)(?:,(-?\d+),(-?\d+))?)?/.exec(rest);
  if (!match) return null;
  return {
    tag: Number(match[1]),
    line: Number(match[2]),
    h: Number(match[3]),
    v: Number(match[4]),
    width: Number(match[5] ?? 0),
    height: Number(match[6] ?? 0),
    depth: Number(match[7] ?? 0),
  };
}

function resolveInput(resolver: PathResolver, raw: string): Path | null {
  const name = raw.trim();
  // TeX Live's own files and the build files TeX writes are never sources to jump to.
  if (/(^|\/)(texlive|texmf[^/]*)\//i.test(name)) return null;
  if (/\.(aux|toc|lof|lot|out|bbl|nav|snm|ind|gls)$/i.test(name)) return null;
  // The engine's file system puts the project at the root: "/sub/./chap.tex", "/./main.tex".
  const cleaned = name.replace(/\/\.\//g, '/').replace(/^\.\//, '');
  return resolver.resolve(cleaned);
}

function area(rect: SyncRect): number {
  return (rect.right - rect.left) * (rect.bottom - rect.top);
}

function sameRect(a: SyncRect, b: SyncRect): boolean {
  return Math.abs(a.left - b.left) < 0.01 && Math.abs(a.top - b.top) < 0.01 && Math.abs(a.right - b.right) < 0.01 && Math.abs(a.bottom - b.bottom) < 0.01;
}
