/**
 * Finds the same passage in two forms of a document: the text a PDF shows and
 * the LaTeX source that made it. Used to tie a selection in the PDF to the
 * source, to turn a reviewer's edit of PDF words into a source change, and to
 * mark a comment on the source at the right words in the PDF.
 *
 * Both sides are first brought to a common form: lower case, ligatures split,
 * dashes and quotes unified, runs of white space as one space.
 */
import { projectLatex } from './latex-plain';
import type { TextChange } from './text-diff';
import { diffText } from './text-diff';

export interface Normalized {
  text: string;
  /** Index in the input of each character of `text`. */
  index: number[];
}

const DASHES = /[‐-―−]/u;
const SINGLE_QUOTES = /[‘’‚‛′`´]/u;
const DOUBLE_QUOTES = /[“-‟″«»]/u;
const SPACE = /[\s\u00a0\u2000-\u200b\u202f\u205f\u3000]/u;

export function normalizeForMatch(input: string): Normalized {
  let text = '';
  const index: number[] = [];
  let offset = 0;
  for (const char of input) {
    const at = offset;
    offset += char.length;
    if (char === '­') continue; // a soft hyphen prints nothing
    let mapped: string;
    if (SPACE.test(char)) mapped = ' ';
    else if (DASHES.test(char)) mapped = '-';
    else if (SINGLE_QUOTES.test(char)) mapped = "'";
    else if (DOUBLE_QUOTES.test(char)) mapped = '"';
    else if (char === '…') mapped = '...';
    else mapped = char.normalize('NFKC').toLowerCase();
    for (const unit of mapped) {
      if (unit === ' ' && (text.length === 0 || text.endsWith(' '))) continue;
      text += unit;
      for (let k = 0; k < unit.length; k++) index.push(at);
    }
  }
  if (text.endsWith(' ')) {
    text = text.slice(0, -1);
    index.pop();
  }
  return { text, index };
}

/** The text a PDF selection shows, as it should appear in an edit box: ligatures split, line breaks and hyphenation undone. */
export function readableSelection(text: string): string {
  return joinHyphenation(text.normalize('NFKC'), '')
    .replace(/[\s\u00a0]+/gu, ' ')
    .trim();
}

function joinHyphenation(text: string, joiner: '' | '-'): string {
  return text.replace(/(\p{L})-[ \t]*\r?\n\s*(\p{L})/gu, `$1${joiner}$2`);
}

/** Forms a PDF selection may have to be looked for in, because a hyphen at a line end may or may not belong to the word. */
function variants(text: string): string[] {
  const joined = joinHyphenation(text, '');
  const kept = joinHyphenation(text, '-');
  const spaced = text.replace(/(\p{L})-\s+(\p{L})/gu, '$1$2');
  return [...new Set([text, joined, kept, spaced])];
}

interface Hit {
  /** Range in the normalized haystack. */
  from: number;
  to: number;
  exact: boolean;
}

function occurrences(hay: string, needle: string): number[] {
  const found: number[] = [];
  if (needle.length === 0) return found;
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) found.push(at);
  return found;
}

/**
 * Looks for `needle` in `hay`, both normalized. An exact hit first; otherwise
 * the passage between its first and its last words, which tolerates maths,
 * citations or a changed word in the middle.
 */
function search(hay: string, needle: string, near: number | null): Hit | null {
  const pick = (candidates: Hit[]): Hit | null => {
    if (candidates.length === 0) return null;
    if (near === null) return candidates[0]!;
    return candidates.reduce((best, hit) => (Math.abs(hit.from - near) < Math.abs(best.from - near) ? hit : best));
  };
  const exact = occurrences(hay, needle).map((from) => ({ from, to: from + needle.length, exact: true }));
  if (exact.length > 0) return pick(exact);

  const words = needle.split(' ').filter(Boolean);
  if (words.length < 2) return null;
  for (let take = Math.min(4, Math.floor(words.length / 2)); take >= 1; take--) {
    const head = words.slice(0, take).join(' ');
    const tail = words.slice(-take).join(' ');
    // Single short words are too common to anchor on.
    if (take === 1 && (head.length < 4 || tail.length < 4)) continue;
    const heads = occurrences(hay, head);
    const tails = occurrences(hay, tail);
    const hits: Hit[] = [];
    for (const start of heads) {
      for (const tailAt of tails) {
        const end = tailAt + tail.length;
        if (tailAt < start + head.length) continue;
        const length = end - start;
        if (length > needle.length * 2 + 40 || length < needle.length / 2) continue;
        hits.push({ from: start, to: end, exact: false });
      }
    }
    if (hits.length > 0) {
      // Prefer the passage whose length is closest to the selection's.
      hits.sort((a, b) => Math.abs(a.to - a.from - needle.length) - Math.abs(b.to - b.from - needle.length));
      const bestLength = Math.abs(hits[0]!.to - hits[0]!.from - needle.length);
      return pick(hits.filter((hit) => Math.abs(hit.to - hit.from - needle.length) <= bestLength + 8));
    }
  }
  return null;
}

export interface SourceMatch {
  from: number;
  to: number;
  /** The words matched one to one; otherwise only the first and last words were found. */
  exact: boolean;
  /** The form of the selection that was found, to show in an edit box. */
  plain: string;
}

/**
 * Where the words of a PDF selection are in the source, within `window`
 * (source offsets) when given. `near` prefers the hit closest to that offset.
 */
export function findInSource(source: string, selection: string, options: { window?: { from: number; to: number }; near?: number } = {}): SourceMatch | null {
  const window = options.window ?? { from: 0, to: source.length };
  const projection = projectLatex(source.slice(window.from, window.to), window.from);
  const hay = normalizeForMatch(projection.text);
  let nearIndex: number | null = null;
  if (options.near !== undefined) {
    const projected = projection.start.findIndex((offset) => offset >= options.near!);
    if (projected >= 0) nearIndex = hay.index.findIndex((at) => at >= projected);
    if (nearIndex !== null && nearIndex < 0) nearIndex = null;
  }
  for (const variant of variants(selection)) {
    const needle = normalizeForMatch(variant).text;
    if (needle.length === 0) continue;
    const hit = search(hay.text, needle, nearIndex);
    if (!hit) continue;
    const first = hay.index[hit.from]!;
    const last = hay.index[hit.to - 1]!;
    return { from: projection.start[first]!, to: projection.end[last]!, exact: hit.exact, plain: readableSelection(variant) };
  }
  return null;
}

/** The plain text a stretch of source reads as, for comparing with what the PDF showed. */
export function plainOf(source: string): string {
  return readableSelection(projectLatex(source).text);
}

/**
 * Turns an edit of plain words into a change of the source range they came
 * from. Returns null when the changed words do not stand in the source as
 * they read (they run through a command, say), so the change cannot be made
 * without understanding the LaTeX.
 */
export function planPlainEdit(source: string, range: { from: number; to: number }, before: string, after: string): TextChange | null {
  const raw = diffText(before, after);
  if (!raw) return null;
  const change = wholeWords(before, raw);
  const projection = projectLatex(source.slice(range.from, range.to), range.from);
  const hay = normalizeForMatch(projection.text);

  // Find the changed words by the unchanged words around them.
  const leftFrom = Math.max(0, change.from - 24);
  const rightTo = Math.min(before.length, change.to + 24);
  const left = before.slice(leftFrom, change.from);
  const middle = before.slice(change.from, change.to);
  const right = before.slice(change.to, rightTo);
  const probe = normalizeForMatch(left + middle + right);
  const found = occurrences(hay.text, probe.text);
  if (found.length !== 1) return null;
  const base = found[0]!;
  const middleStart = left.length;
  const middleEnd = left.length + middle.length;
  let first = probe.index.findIndex((at) => at >= middleStart);
  if (first < 0) first = probe.text.length;
  let end = probe.index.findIndex((at) => at >= middleEnd);
  if (end < 0) end = probe.text.length;

  let from: number;
  let to: number;
  if (end > first) {
    const firstChar = hay.index[base + first]!;
    const lastChar = hay.index[base + end - 1]!;
    from = projection.start[firstChar]!;
    to = projection.end[lastChar]!;
    // The changed words must stand in the source as plain words: no command,
    // brace or maths may be cut in half or dropped by replacing them.
    const slice = source.slice(from, to);
    if (/[\\{}$%&]/.test(slice) || normalizeForMatch(plainOf(slice)).text !== normalizeForMatch(middle).text) return null;
  } else {
    // Only an insertion. Text that continues a word goes right after it, inside
    // any command around that word; anything else goes before what follows.
    const hasBefore = base + first > 0;
    const hasAfter = base + first < hay.text.length && first < probe.text.length;
    const continuesWord = hasBefore && /^[\p{L}\p{N}]/u.test(change.insert) && hay.text[base + first - 1] !== ' ';
    if (hasBefore && (continuesWord || !hasAfter)) {
      from = projection.end[hay.index[base + first - 1]!]!;
    } else if (hasAfter) {
      from = projection.start[hay.index[base + first]!]!;
    } else {
      from = range.from;
    }
    to = from;
  }
  // In inline maths, text commands such as \textasciitilde would not compile.
  if (/[~^\\]/.test(change.insert) && insideInlineMath(source, from)) return null;
  return { from, to, insert: escapeLatex(change.insert) };
}

/** Whether `at` lies inside `$...$`, judged by the dollar signs since the paragraph began. */
function insideInlineMath(source: string, at: number): boolean {
  let inside = false;
  for (let index = source.lastIndexOf('\n\n', at) + 1; index < at; index++) {
    const char = source[index];
    if (char === '\\') {
      index++;
    } else if (char === '%') {
      const end = source.indexOf('\n', index);
      if (end < 0 || end >= at) break;
      index = end;
    } else if (char === '$') {
      inside = !inside;
    }
  }
  return inside;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Widens a change that starts or ends inside a word to the whole word, so a
 * suggestion reads "two times higher → twice as high", not "o times higher →
 * ice as high". An insertion between words stays an insertion.
 */
function wholeWords(before: string, change: TextChange): TextChange {
  let { from, to, insert } = change;
  const removed = before.slice(from, to);
  const startsInWord = WORD_CHAR.test(removed.charAt(0)) || WORD_CHAR.test(insert.charAt(0));
  const endsInWord = WORD_CHAR.test(removed.charAt(removed.length - 1)) || WORD_CHAR.test(insert.charAt(insert.length - 1));
  if (startsInWord) {
    while (from > 0 && inWord(before, from - 1)) {
      from--;
      insert = before.charAt(from) + insert;
    }
  }
  if (endsInWord) {
    while (to < before.length && inWord(before, to)) {
      insert += before.charAt(to);
      to++;
    }
  }
  return { from, to, insert };
}

/** A letter or digit, or the point or comma of a number such as 0.01. */
function inWord(text: string, at: number): boolean {
  const char = text.charAt(at);
  if (WORD_CHAR.test(char)) return true;
  return (char === '.' || char === ',') && /\d/.test(text.charAt(at - 1)) && /\d/.test(text.charAt(at + 1));
}

/** Writes plain text so that LaTeX prints it as it is. */
export function escapeLatex(text: string): string {
  return text.replace(/[\\&%$#_{}~^]/g, (char) => {
    switch (char) {
      case '\\':
        return '\\textbackslash{}';
      case '~':
        return '\\textasciitilde{}';
      case '^':
        return '\\textasciicircum{}';
      default:
        return `\\${char}`;
    }
  });
}

// ---- in the PDF --------------------------------------------------------------

/** A run of text on a PDF page, in PDF points from the page's top left corner. */
export interface PageTextItem {
  str: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Marks the words of `quote` (plain text) among the text items of a page,
 * looking only at items that overlap `near` when given (the lines SyncTeX
 * names). Returns one rectangle per line part, or null when the words are not
 * there.
 */
/**
 * Widths of characters in Computer Modern, LaTeX's own font, in thousandths
 * of an em. A run of PDF text only knows its total width; these say where in
 * it a word starts far better than equal widths would, also for other fonts.
 */
const GLYPH_WIDTHS: Record<string, number> = {
  a: 500, b: 556, c: 444, d: 556, e: 444, f: 306, g: 500, h: 556, i: 278, j: 306, k: 528, l: 278, m: 833,
  n: 556, o: 500, p: 556, q: 528, r: 392, s: 394, t: 389, u: 556, v: 528, w: 722, x: 528, y: 528, z: 444,
  A: 750, B: 708, C: 722, D: 764, E: 681, F: 653, G: 785, H: 750, I: 361, J: 514, K: 778, L: 625, M: 917,
  N: 750, O: 778, P: 681, Q: 778, R: 736, S: 556, T: 722, U: 750, V: 750, W: 1028, X: 750, Y: 750, Z: 611,
  ' ': 333, '.': 278, ',': 278, ';': 278, ':': 278, '!': 278, '?': 472, "'": 278, '‘': 278, '’': 278,
  '“': 500, '”': 500, '(': 389, ')': 389, '[': 278, ']': 278, '-': 333, '–': 500, '—': 1000, '/': 500, '%': 833,
};

function glyphWidth(char: string): number {
  return GLYPH_WIDTHS[char] ?? (/\p{Lu}/u.test(char) ? 740 : 500);
}

/** How far into `text` its character `at` begins, as a share of the whole width. */
function share(text: string, at: number): number {
  let before = 0;
  let total = 0;
  for (let index = 0; index < text.length; index++) {
    const width = glyphWidth(text[index]!);
    if (index < at) before += width;
    total += width;
  }
  return total > 0 ? before / total : 0;
}

export function findOnPage(items: readonly PageTextItem[], quote: string, near?: readonly Box[]): Box[] | null {
  const candidates = near && near.length > 0 ? items.filter((item) => near.some((box) => overlaps(item, box))) : items;
  if (candidates.length === 0) return null;
  // The items as one string, remembering which item and character each comes from.
  let text = '';
  const owner: { item: number; char: number }[] = [];
  candidates.forEach((item, position) => {
    const next = candidates[position + 1];
    const lineEnds = !next || next.top > item.bottom - 1;
    // Pieces of one word sit right next to each other, as in "0" "." "01" of 0.01 in maths.
    const touches = !lineEnds && next.left - item.right < (item.bottom - item.top) * 0.15;
    let str = item.str;
    // A hyphen at the end of a line is (usually) TeX's hyphenation.
    const hyphenated = lineEnds && /\p{L}-$/u.test(str);
    if (hyphenated) str = str.slice(0, -1);
    for (let k = 0; k < str.length; k++) {
      text += str[k];
      owner.push({ item: position, char: k });
    }
    if (!hyphenated && !touches) {
      text += ' ';
      owner.push({ item: position, char: str.length });
    }
  });
  const hay = normalizeForMatch(text);
  const needle = normalizeForMatch(quote).text;
  if (needle.length === 0) return null;
  const hit = search(hay.text, needle, null);
  if (!hit) return null;
  const firstOwner = owner[hay.index[hit.from]!]!;
  const lastOwner = owner[hay.index[hit.to - 1]!]!;
  const boxes: Box[] = [];
  for (let position = firstOwner.item; position <= lastOwner.item; position++) {
    const item = candidates[position]!;
    const length = Math.max(1, item.str.length);
    const fromChar = position === firstOwner.item ? firstOwner.char : 0;
    const toChar = position === lastOwner.item ? Math.min(length, lastOwner.char + 1) : length;
    if (toChar <= fromChar) continue;
    const width = item.right - item.left;
    const box = { left: item.left + width * share(item.str, fromChar), right: item.left + width * share(item.str, toChar), top: item.top, bottom: item.bottom };
    const last = boxes.at(-1);
    // Items on the same line become one rectangle.
    if (last && Math.abs(last.top - box.top) < 2 && box.left - last.right < 12) {
      last.right = Math.max(last.right, box.right);
      last.left = Math.min(last.left, box.left);
      last.bottom = Math.max(last.bottom, box.bottom);
    } else {
      boxes.push(box);
    }
  }
  return boxes.length > 0 ? boxes : null;
}

function overlaps(item: Box, box: Box): boolean {
  const vertical = Math.min(item.bottom, box.bottom) - Math.max(item.top, box.top);
  return vertical > Math.min(item.bottom - item.top, box.bottom - box.top) * 0.3 && item.right >= box.left - 2 && item.left <= box.right + 2;
}
