/**
 * Finds the same passage in two forms of a document: the text a PDF shows and
 * the LaTeX source that made it. Used to tie a selection in the PDF to the
 * source, to turn a reviewer's edit of PDF words into a source change, and to
 * mark a comment on the source at the right words in the PDF.
 *
 * Both sides are first brought to a common form: lower case, ligatures split,
 * dashes and quotes unified, runs of white space as one space.
 */
import { type MathSpan, projectLatex, usesGermanShorthands } from './latex-plain';
import type { TextChange } from './text-diff';
import { diffText } from './text-diff';

export interface Normalized {
  text: string;
  /** Index in the input of each character of `text`. */
  index: number[];
}

const DASHES = /[‐-―−]/u;
const SINGLE_QUOTES = /[‘’‚‛′]/u;
/**
 * Accents that fonts without T1 encoding print as a glyph of their own next to
 * the letter, so the PDF reads "Gr¨oße" where the source says "Größe".
 */
const SPACING_ACCENTS: Record<string, string> = {
  '\u00a8': '\u0308',
  '\u00b4': '\u0301',
  '`': '\u0300',
  '\u02c6': '\u0302',
  '\u02dc': '\u0303',
  '\u00af': '\u0304',
  '\u02d9': '\u0307',
  '\u02da': '\u030a',
  '\u02c7': '\u030c',
  '\u02d8': '\u0306',
  '\u02dd': '\u030b',
  '\u00b8': '\u0327',
  '\u02db': '\u0328',
};
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
    // Accents are left out on both sides, so "Größe", "Gro\\ss e" and "Gr¨oße" all read "große".
    else if (SPACING_ACCENTS[char] !== undefined) continue;
    else mapped = foldAccents(char.normalize('NFKC').toLowerCase());
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

function foldAccents(text: string): string {
  return /\P{ASCII}/u.test(text) ? text.normalize('NFKD').replace(/\p{M}/gu, '') : text;
}

/** The text a PDF selection shows, as it should appear in an edit box: ligatures split, line breaks and hyphenation undone. */
export function readableSelection(text: string): string {
  return joinHyphenation(joinAccents(text).normalize('NFKC'), '')
    .replace(/[\s\u00a0]+/gu, ' ')
    .trim();
}

/** Puts accents that a PDF shows as glyphs of their own back on their letters: "Gr¨oße" reads "Größe". */
function joinAccents(text: string): string {
  return text
    .replace(/([\u00a8\u00b4`\u02c6\u02dc\u00af\u02d9\u02da\u02c7\u02d8\u02dd])(\p{L})/gu, (_, accent: string, letter: string) => `${letter}${SPACING_ACCENTS[accent]}`.normalize('NFC'))
    .replace(/(\p{L})([\u00b8\u02db])/gu, (_, letter: string, accent: string) => `${letter}${SPACING_ACCENTS[accent]}`.normalize('NFC'));
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

/** What tells apart several places where the same words stand. */
interface SearchOptions {
  /** The text just before and after the passage, as the other side shows it (normalized). */
  context?: { before: string; after: string } | null;
  /** Prefer hits that start in this range of the haystack. */
  prefer?: { from: number; to: number } | null;
  /** Prefer the hit closest to this index of the haystack. */
  near?: number | null;
}

const WORD = /[\p{L}\p{N}]/u;

/**
 * Picks the hit meant: whole words before parts of words ("is" is not the end
 * of "This"), then the one whose surroundings read like `context`, then one
 * in `prefer`, then the one closest to `near`.
 */
function pick(hay: string, needle: string, candidates: Hit[], options: SearchOptions): Hit | null {
  if (candidates.length <= 1) return candidates[0] ?? null;
  let best = candidates;
  const whole = best.filter((hit) => !(WORD.test(needle[0] ?? '') && WORD.test(hay[hit.from - 1] ?? '')) && !(WORD.test(needle.at(-1) ?? '') && WORD.test(hay[hit.to] ?? '')));
  if (whole.length > 0) best = whole;
  const context = options.context;
  if (best.length > 1 && context && (context.before || context.after)) {
    const scores = best.map((hit) => contextScore(hay, hit, context.before, context.after));
    const top = Math.max(...scores);
    if (top > 0) best = best.filter((_, index) => scores[index] === top);
  }
  const prefer = options.prefer;
  if (best.length > 1 && prefer) {
    const inside = best.filter((hit) => hit.from >= prefer.from && hit.from < prefer.to);
    if (inside.length > 0) best = inside;
  }
  const near = options.near;
  if (best.length > 1 && near !== null && near !== undefined) {
    return best.reduce((closest, hit) => (Math.abs(hit.from - near) < Math.abs(closest.from - near) ? hit : closest));
  }
  return best[0]!;
}

/** How many characters before and after a hit agree with the context, spaces aside. */
function contextScore(hay: string, hit: Hit, before: string, after: string): number {
  let score = 0;
  for (let a = hit.from - 1, b = before.length - 1, seen = 0; a >= 0 && b >= 0 && seen < 80; ) {
    if (hay[a] === ' ') a--;
    else if (before[b] === ' ') b--;
    else if (hay[a] !== before[b]) break;
    else {
      score++;
      seen++;
      a--;
      b--;
    }
  }
  for (let a = hit.to, b = 0, seen = 0; a < hay.length && b < after.length && seen < 80; ) {
    if (hay[a] === ' ') a++;
    else if (after[b] === ' ') b++;
    else if (hay[a] !== after[b]) break;
    else {
      score++;
      seen++;
      a++;
      b++;
    }
  }
  return score;
}

/**
 * Looks for `needle` in `hay`, both normalized. An exact hit first; otherwise
 * the passage between its first and its last words, which tolerates maths,
 * citations or a changed word in the middle.
 */
function search(hay: string, needle: string, options: SearchOptions = {}): Hit | null {
  const exact = occurrences(hay, needle).map((from) => ({ from, to: from + needle.length, exact: true }));
  if (exact.length > 0) return pick(hay, needle, exact, options);

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
      return pick(
        hay,
        needle,
        hits.filter((hit) => Math.abs(hit.to - hit.from - needle.length) <= bestLength + 8),
        options,
      );
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
 * (source offsets) when given. When the words stand there more than once,
 * `context` (the text around the selection on the page, see
 * selectionContext) decides, then `prefer` (a source range, such as the line
 * SyncTeX names), then `near` (the hit closest to that offset).
 */
export function findInSource(
  source: string,
  selection: string,
  options: { window?: { from: number; to: number }; near?: number; prefer?: { from: number; to: number }; context?: { before: string; after: string } | null } = {},
): SourceMatch | null {
  const window = options.window ?? { from: 0, to: source.length };
  const projection = projectLatex(source.slice(window.from, window.to), window.from, { german: usesGermanShorthands(source) });
  const hay = normalizeForMatch(projection.text);
  /** The index in the haystack of the first character that comes from `offset` of the source or later. */
  const toHay = (offset: number): number | null => {
    const projected = projection.start.findIndex((at) => at >= offset);
    if (projected < 0) return null;
    const index = hay.index.findIndex((at) => at >= projected);
    return index < 0 ? null : index;
  };
  const nearIndex = options.near !== undefined ? toHay(options.near) : null;
  let prefer: { from: number; to: number } | null = null;
  if (options.prefer) {
    const from = toHay(options.prefer.from);
    if (from !== null) prefer = { from, to: toHay(options.prefer.to) ?? hay.text.length };
  }
  for (const variant of variants(selection)) {
    const needle = normalizeForMatch(variant).text;
    if (needle.length === 0) continue;
    const hit = search(hay.text, needle, { near: nearIndex, prefer, context: options.context ?? null });
    if (!hit) continue;
    const first = hay.index[hit.from]!;
    const last = hay.index[hit.to - 1]!;
    return { from: projection.start[first]!, to: projection.end[last]!, exact: hit.exact, plain: readableSelection(variant) };
  }
  return null;
}

/** The plain text a stretch of source reads as, for comparing with what the PDF showed. */
export function plainOf(source: string, options: { german?: boolean } = {}): string {
  return readableSelection(projectLatex(source, 0, options).text);
}

/**
 * The plain text just before and after a range of the source (normalized), to
 * tell apart places where the same words stand. The lines around the range
 * are read whole, so maths and commands are read from their start.
 */
export function contextAround(source: string, from: number, to: number): { before: string; after: string } {
  const windowFrom = source.lastIndexOf('\n', Math.max(0, from - 300)) + 1;
  const lineEnd = source.indexOf('\n', Math.min(source.length, to + 300));
  const windowTo = lineEnd < 0 ? source.length : lineEnd;
  const projection = projectLatex(source.slice(windowFrom, windowTo), windowFrom, { german: usesGermanShorthands(source) });
  let before = '';
  let after = '';
  for (let index = 0; index < projection.text.length; index++) {
    if (projection.end[index]! <= from) before += projection.text[index];
    else if (projection.start[index]! >= to) after += projection.text[index];
  }
  return { before: normalizeForMatch(before.slice(-120)).text, after: normalizeForMatch(after.slice(0, 120)).text };
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
  // The whole paragraphs around the range are read, so maths and commands are read from their start.
  const paragraphFrom = paragraphStart(source, range.from);
  const projection = projectLatex(source.slice(paragraphFrom, paragraphEnd(source, range.to)), paragraphFrom, { german: usesGermanShorthands(source) });
  const hay = normalizeForMatch(projection.text);

  // Find the changed words by the unchanged words around them, inside the range.
  const leftFrom = Math.max(0, change.from - 24);
  const rightTo = Math.min(before.length, change.to + 24);
  const left = before.slice(leftFrom, change.from);
  const middle = before.slice(change.from, change.to);
  const right = before.slice(change.to, rightTo);
  const probe = normalizeForMatch(left + middle + right);
  if (probe.text.length === 0) return null;
  const found = occurrences(hay.text, probe.text).filter((at) => {
    const from = projection.start[hay.index[at]!]!;
    const to = projection.end[hay.index[at + probe.text.length - 1]!]!;
    return from >= range.from - 2 && to <= range.to + 2;
  });
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
  let insert = change.insert;
  if (end > first) {
    const firstChar = hay.index[base + first]!;
    const lastChar = hay.index[base + end - 1]!;
    from = projection.start[firstChar]!;
    to = projection.end[lastChar]!;
    // A paragraph break at either end stays: the reviewer changed the words next to it.
    const lead = /^\s*\n[ \t]*\n\s*/.exec(source.slice(from, to));
    if (lead) {
      from += lead[0].length;
      if (insert.startsWith(' ')) insert = insert.slice(1);
    }
    const trail = /\s*\n[ \t]*\n\s*$/.exec(source.slice(from, to));
    if (trail && from < to) {
      to -= trail[0].length;
      if (insert.endsWith(' ')) insert = insert.slice(0, -1);
    }
    if (from > to) return null;
    // The changed words must stand in the source as plain words: no command,
    // brace or maths may be cut in half or dropped by replacing them, and two
    // paragraphs may not be joined.
    const slice = source.slice(from, to);
    if (/[\\{}$%&]/.test(slice) || /\n[ \t]*\n/.test(slice)) return null;
    if (normalizeForMatch(plainOf(slice)).text !== normalizeForMatch(lead || trail ? middle.trim() : middle).text) return null;
    const math = mathAround(projection.math, from, to);
    if (math) {
      // Inside a formula only numbers, signs and single letters can be changed as they read.
      if (!mathSafe(insert)) return null;
      if (insert === '' && from === math.from && to === math.to) {
        // Emptying a formula takes its dollar signs too.
        from = math.open;
        to = math.close;
      }
    }
  } else {
    // Only an insertion. Text that continues a word goes right after it, inside
    // any command around that word; anything else goes before what follows.
    const hasBefore = base + first > 0;
    const hasAfter = base + first < hay.text.length && first < probe.text.length;
    const continuesWord = hasBefore && /^[\p{L}\p{N}]/u.test(insert) && hay.text[base + first - 1] !== ' ';
    if (hasBefore && (continuesWord || !hasAfter)) {
      from = projection.end[hay.index[base + first - 1]!]!;
    } else if (hasAfter) {
      from = projection.start[hay.index[base + first]!]!;
    } else {
      from = range.from;
    }
    const math = mathAround(projection.math, from, from);
    if (math && !mathSafe(insert)) {
      // Words that go next to a formula go outside its dollar signs.
      if (from === math.from) from = math.open;
      else if (from === math.to) from = math.close;
      else return null;
    }
    to = from;
  }
  // "\LaTeX" followed by a letter would read as another command, and a space after it would be lost.
  const braces = endsWithControlWord(source, from) && /^[\p{L}\s]/u.test(insert) ? '{}' : '';
  return { from, to, insert: braces + escapeLatex(insert) };
}

/** The formula that a range lies in, its edges included. */
function mathAround(spans: readonly MathSpan[], from: number, to: number): MathSpan | null {
  return spans.find((span) => span.from <= from && to <= span.to) ?? null;
}

/** Text that reads the same in maths as in the PDF: numbers, signs and single letters, no words or spaces. */
function mathSafe(text: string): boolean {
  return /^[\p{N}\p{L}.,;:!?+\-=<>()[\]/|']*$/u.test(text) && !/\p{L}{2}/u.test(text);
}

/** Whether a control word such as \LaTeX ends right at `at`, or only the spaces it swallows lie between. */
function endsWithControlWord(source: string, at: number): boolean {
  let end = at;
  while (end > 0 && (source[end - 1] === ' ' || source[end - 1] === '\t')) end--;
  let start = end;
  while (start > 0 && /[A-Za-z@]/.test(source[start - 1]!)) start--;
  if (start === end) return false;
  let slashes = 0;
  for (let index = start - 1; index >= 0 && source[index] === '\\'; index--) slashes++;
  return slashes % 2 === 1;
}

const PARAGRAPH_BREAK = /\n[ \t]*\n/g;

/** Where the paragraph that holds `at` begins. */
function paragraphStart(source: string, at: number): number {
  let start = 0;
  PARAGRAPH_BREAK.lastIndex = 0;
  for (let match = PARAGRAPH_BREAK.exec(source); match && match.index + match[0].length <= at; match = PARAGRAPH_BREAK.exec(source)) {
    start = match.index + match[0].length;
  }
  return start;
}

/** Where the paragraph that holds `at` ends. */
function paragraphEnd(source: string, at: number): number {
  PARAGRAPH_BREAK.lastIndex = at;
  const match = PARAGRAPH_BREAK.exec(source);
  return match ? match.index : source.length;
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

/** The text items of a page as one string, remembering which item and character each character comes from. */
function joinItems(items: readonly PageTextItem[]): { text: string; owner: { item: number; char: number }[] } {
  let text = '';
  const owner: { item: number; char: number }[] = [];
  items.forEach((item, position) => {
    const next = items[position + 1];
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
  return { text, owner };
}

/**
 * The text just before and after a selection on its page (normalized), to
 * find the selected words in the source when they stand there more than
 * once. `start` is where the selection begins on the page.
 */
export function selectionContext(items: readonly PageTextItem[], selection: string, start: { x: number; y: number } | null): { before: string; after: string } | null {
  const { text, owner } = joinItems(items);
  const hay = normalizeForMatch(text);
  for (const variant of variants(selection)) {
    const needle = normalizeForMatch(variant).text;
    if (needle.length === 0) continue;
    const found = occurrences(hay.text, needle);
    if (found.length === 0) continue;
    const distance = (at: number): number => {
      if (!start) return 0;
      const where = owner[hay.index[at]!]!;
      const item = items[where.item]!;
      const x = item.left + (item.right - item.left) * share(item.str, where.char);
      return Math.abs((item.top + item.bottom) / 2 - start.y) * 4 + Math.abs(x - start.x);
    };
    const at = found.reduce((best, candidate) => (distance(candidate) < distance(best) ? candidate : best));
    return { before: hay.text.slice(Math.max(0, at - 120), at).trimEnd(), after: hay.text.slice(at + needle.length, at + needle.length + 120).trimStart() };
  }
  return null;
}

/**
 * Marks the words of `quote` (plain text) among the text items of a page,
 * looking only at items that overlap `near` when given (the lines SyncTeX
 * names). `context` (see contextAround) tells apart places where the same
 * words stand. Returns one rectangle per line part, or null when the words
 * are not there.
 */
export function findOnPage(items: readonly PageTextItem[], quote: string, near?: readonly Box[], context?: { before: string; after: string } | null): Box[] | null {
  const candidates = near && near.length > 0 ? items.filter((item) => near.some((box) => overlaps(item, box))) : items;
  if (candidates.length === 0) return null;
  const { text, owner } = joinItems(candidates);
  const hay = normalizeForMatch(text);
  const needle = normalizeForMatch(quote).text;
  if (needle.length === 0) return null;
  const hit = search(hay.text, needle, { context: context ?? null });
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
