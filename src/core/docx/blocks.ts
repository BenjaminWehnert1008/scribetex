/** The pieces a Word document is turned into, and how the pieces of a paragraph become LaTeX. */
import { escapeText, type EscapeStats } from './latex-text';

export const F_BOLD = 1;

export const F_ITALIC = 2;

export const F_UNDERLINE = 4;

export const F_STRIKE = 8;

export const F_SMALLCAPS = 16;

export const F_MONO = 32;

export const F_SUP = 64;

export const F_SUB = 128;

export interface Seg {
  latex: string;
  /** The lines of a displayed equation, so a paragraph can number it afterwards. */
  math?: string[];
  plain: string;
  /** Formatting flags for text; raw pieces (commands) have none and keep their place. */
  flags: number;
  raw?: boolean;
  lineBreak?: boolean;
}

export interface ImageRef {
  /** The picture's part path in the .docx. */
  part: string;
  /** Width as a fraction of the text width, 0 when unknown. */
  width: number;
  anchored: boolean;
}

export interface CaptionBlock {
  kind: 'caption';
  /** The caption without "Figure 3:", which LaTeX writes itself. */
  latex: string;
  /** The paragraph as it was, for a caption that has no picture or table next to it. */
  full: string;
  plain: string;
  /** A version without footnote marks, for the list of figures. */
  short: string | null;
  target: 'figure' | 'table' | null;
  bookmarks: string[];
  /** Footnote texts that follow the float, since \footnote does not work inside \caption. */
  deferred: string[];
}

/** A caption joined to its picture or table, above or below it. */
export interface PlacedCaption extends CaptionBlock {
  above: boolean;
}

export type Block =
  | { kind: 'heading'; level: number; latex: string; short: string | null; plain: string; bookmarks: string[]; deferred: string[] }
  | { kind: 'para'; latex: string; plain: string; align?: 'center' | 'right'; quote?: boolean; bookmarks: string[] }
  | { kind: 'code'; text: string }
  | { kind: 'item'; latex: string; plain: string; ordered: boolean; depth: number; numId: string; value: number; label: string | null }
  | { kind: 'figure'; images: ImageRef[]; bookmarks: string[]; caption?: PlacedCaption }
  | CaptionBlock
  | { kind: 'table'; head: string[]; body: string[]; spec: string; rows: number; deferred: string[]; caption?: PlacedCaption }
  | { kind: 'raw'; latex: string }
  | { kind: 'toc'; which: 'contents' | 'figures' | 'tables' }
  | { kind: 'bibliography' };

/** Tokens in the text that are filled in once the whole document is read. */
export const TOKEN = '\u0001';

export const CAPTION_PREFIX = /^\s*(figure|fig\.?|abbildung|abb\.?|bild|grafik|table|tab\.?|tabelle|chart|diagramm|figura|tabla|tabella|afbeelding|tabel)\s*[0-9]*(?:[.\-–][0-9]+)*\s*[:.\-–—]?\s*/i;

/** A block written as running text, for table cells and footnotes. */
export function flatBlock(block: Block): string {
  switch (block.kind) {
    case 'heading':
      return `\\textbf{${block.latex}}`;
    case 'para':
    case 'caption':
      return block.latex;
    case 'item':
      return `${block.ordered ? `${block.value}.` : '\\textbullet{}'}~${block.latex}`;
    case 'code':
      return `\\texttt{${escapeText(block.text).replace(/\n/g, '\\newline ')}}`;
    case 'figure':
      return block.images.map((image) => `${TOKEN}F${image.part}${TOKEN}${image.width}${TOKEN}`).join(' ');
    case 'raw':
      return block.latex.startsWith('\\clearpage') ? '' : block.latex.replace(/\\\[\s*([\s\S]*?)\s*\\\]/g, '$\\displaystyle $1$');
    default:
      return '';
  }
}

/** Splits at \\ that are not inside an environment such as a matrix. */
export function splitTopLevelBreaks(latex: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  const token = /\\begin\{[^}]*\}|\\end\{[^}]*\}|\\\\/g;
  let match: RegExpExecArray | null;
  while ((match = token.exec(latex)) !== null) {
    if (match[0].startsWith('\\begin')) depth++;
    else if (match[0].startsWith('\\end')) depth--;
    else if (depth === 0) {
      parts.push(latex.slice(start, match.index).trim());
      start = match.index + 2;
    }
  }
  parts.push(latex.slice(start).trim());
  return parts.filter((part) => part !== '');
}

/** Word 365 writes an equation's number into the equation: "E=mc^2#(1)". */
export const WORD_EQUATION_NUMBER = /\s*\\#\s*(?:\\left\(\s*[\d.\-–]+\s*\\right\)|\([\d.\-–]+\))\s*$/;

/** A displayed equation; numbered when Word numbered it. */
export function displayMath(lines: string[], numberedInText: boolean): string {
  let numbered = numberedInText;
  const rows = lines.flatMap((line) => {
    let text = line;
    // A single-row equation array (how Word keeps a numbered equation) is just the equation.
    const wrapped = /^\\begin\{(gathered|aligned)\}([\s\S]*)\\end\{\1\}$/.exec(text);
    if (wrapped && splitTopLevelBreaks(wrapped[2]!).length === 1) text = wrapped[2]!.trim();
    const number = WORD_EQUATION_NUMBER.exec(text);
    if (number) {
      numbered = true;
      text = text.slice(0, number.index);
    }
    return splitTopLevelBreaks(text);
  });
  if (rows.length === 0) return '';
  if (rows.length === 1) return numbered ? `\\begin{equation}\n  ${rows[0]}\n\\end{equation}` : `\\[\n  ${rows[0]}\n\\]`;
  const env = numbered ? 'gather' : 'gather*';
  return `\\begin{${env}}\n  ${rows.join(' \\\\\n  ')}\n\\end{${env}}`;
}

export function textSeg(text: string, flags: number, stats: EscapeStats): Seg {
  return { latex: escapeText(text, stats), plain: text, flags };
}

export function withLabels(latex: string, bookmarks: string[]): string {
  return bookmarks.length ? `${bookmarks.map((name) => `${TOKEN}L${name}${TOKEN}`).join('')}${latex}` : latex;
}

/** Formats a paragraph's pieces, grouping neighbours with the same formatting. */
export function segsToLatex(segs: Seg[], moving = false): string {
  // Line breaks at the start or end of a paragraph would stop LaTeX ("There's no line here to end").
  let start = 0;
  let end = segs.length;
  while (start < end && (segs[start]!.lineBreak || segs[start]!.latex.trim() === '')) start++;
  while (end > start && (segs[end - 1]!.lineBreak || segs[end - 1]!.latex.trim() === '')) end--;
  let out = '';
  let k = start;
  while (k < end) {
    const seg = segs[k]!;
    if (seg.lineBreak) {
      while (k + 1 < end && (segs[k + 1]!.lineBreak || segs[k + 1]!.latex.trim() === '')) k++;
      out += moving ? ' ' : seg.latex === '\\clearpage{}' ? '\n\n\\clearpage\n\n' : '\\newline ';
      k++;
      continue;
    }
    if (seg.raw || seg.flags === 0) {
      out += seg.latex;
      k++;
      continue;
    }
    let text = '';
    const flags = seg.flags;
    while (k < end && !segs[k]!.raw && !segs[k]!.lineBreak && segs[k]!.flags === flags) {
      text += segs[k]!.latex;
      k++;
    }
    const lead = /^\s*/.exec(text)![0];
    const trail = /\s*$/.exec(text)![0];
    const core = text.trim();
    out += core ? lead + wrap(core, flags) + trail : text;
  }
  return out.replace(/(\S)[ \t]{2,}/g, '$1 ').trim();
}

export function wrap(text: string, flags: number): string {
  let out = text;
  if (flags & F_MONO) out = `\\texttt{${out}}`;
  if (flags & F_SMALLCAPS) out = `\\textsc{${out}}`;
  if (flags & F_ITALIC) out = `\\emph{${out}}`;
  if (flags & F_BOLD) out = `\\textbf{${out}}`;
  if (flags & F_UNDERLINE) out = `\\uline{${out}}`;
  if (flags & F_STRIKE) out = `\\sout{${out}}`;
  if (flags & F_SUP) out = `\\textsuperscript{${out}}`;
  if (flags & F_SUB) out = `\\textsubscript{${out}}`;
  return out;
}

export function stripHeadingNumber(text: string): string {
  return text
    .replace(/^\s*(?:(?:chapter|kapitel|section|abschnitt|chapitre|capítulo|capitolo|hoofdstuk)\s+)?(?:\d{1,2}(?:\.\d{1,2})*\.?|[IVXLC]+\.)(?=[\s:.\-–—])\s*[:.\-–—]?\s*/i, '')
    .trim();
}

/** The caption text without the "Figure 3:" Word puts in front of it. */
export function stripCaptionPrefix(segs: Seg[]): string {
  const latex = segsToLatex(segs, true);
  const match = CAPTION_PREFIX.exec(latex);
  // "Table 1" alone: LaTeX prints the label and number itself.
  if (match) return latex.slice(match[0].length).trim();
  // The prefix can be inside formatting (\textbf{Figure 1:} Text).
  const formatted = /^\\textbf\{([^{}]*)\}\s*/.exec(latex);
  if (formatted && CAPTION_PREFIX.test(formatted[1]!) && formatted[1]!.replace(CAPTION_PREFIX, '').trim() === '') return latex.slice(formatted[0].length).trim();
  return latex;
}
