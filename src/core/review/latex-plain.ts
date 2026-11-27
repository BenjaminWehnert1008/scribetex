/**
 * Reads LaTeX source roughly the way a reader sees the PDF: the words, without
 * commands, comments, braces and maths. Every character of the result knows
 * which part of the source made it, so a passage someone selected in the PDF
 * can be found in the source, and a small change to its words can be made to
 * exactly the right characters there.
 *
 * It is a reading aid, not a TeX implementation: macros are not expanded,
 * and what it cannot read (maths, citations, references) becomes a space,
 * which the matching treats as a gap.
 */

export interface Projection {
  text: string;
  /** Source range [start[i], end[i]) that produced character i of `text`; offsets include `base`. */
  start: number[];
  end: number[];
}

/** Commands that print a fixed text. */
const SYMBOLS: Record<string, string> = {
  LaTeX: 'LaTeX',
  LaTeXe: 'LaTeX2e',
  TeX: 'TeX',
  BibTeX: 'BibTeX',
  ldots: '...',
  dots: '...',
  textellipsis: '...',
  textendash: '–',
  textemdash: '—',
  textquoteleft: '‘',
  textquoteright: '’',
  textquotedblleft: '“',
  textquotedblright: '”',
  ss: 'ß',
  o: 'ø',
  O: 'Ø',
  ae: 'æ',
  AE: 'Æ',
  oe: 'œ',
  OE: 'Œ',
  aa: 'å',
  AA: 'Å',
  l: 'ł',
  L: 'Ł',
  S: '§',
  P: '¶',
  copyright: '©',
  textregistered: '®',
  texttrademark: '™',
  euro: '€',
  textdegree: '°',
  textbackslash: '\\',
  textasciitilde: '~',
  textunderscore: '_',
  textbar: '|',
  textless: '<',
  textgreater: '>',
  slash: '/',
  quad: ' ',
  qquad: ' ',
  enspace: ' ',
  space: ' ',
  newline: ' ',
  linebreak: ' ',
  par: ' ',
  item: ' ',
};

/** Commands whose arguments print nothing that can be matched, or print something else entirely. */
const DROP_ARGS: Record<string, number> = {
  cite: 1,
  citep: 1,
  citet: 1,
  citeauthor: 1,
  citeyear: 1,
  parencite: 1,
  textcite: 1,
  autocite: 1,
  footcite: 1,
  nocite: 1,
  ref: 1,
  eqref: 1,
  autoref: 1,
  cref: 1,
  Cref: 1,
  pageref: 1,
  nameref: 1,
  label: 1,
  includegraphics: 1,
  input: 1,
  include: 1,
  bibliography: 1,
  bibliographystyle: 1,
  addbibresource: 1,
  usepackage: 1,
  documentclass: 1,
  begin: 1,
  end: 1,
  vspace: 1,
  hspace: 1,
  setlength: 2,
  addtolength: 2,
  setcounter: 2,
  addtocounter: 2,
  pagestyle: 1,
  thispagestyle: 1,
  pagenumbering: 1,
  color: 1,
  newcommand: 2,
  renewcommand: 2,
  providecommand: 2,
  newenvironment: 3,
  renewenvironment: 3,
  hypersetup: 1,
  geometry: 1,
  graphicspath: 1,
  definecolor: 3,
  rule: 2,
  url: 1,
  path: 1,
};

/** Commands with a first argument to skip and the second one printed. */
const SKIP_FIRST = new Set(['textcolor', 'href', 'colorbox']);

/** Letter accents: \c{c}, \v{s}, ... with the combining mark they put on the letter. */
const LETTER_ACCENTS: Record<string, string> = { c: '̧', v: '̌', u: '̆', H: '̋', k: '̨', r: '̊', d: '̣', b: '̱', t: '͡' };
/** Symbol accents: \"a, \'e, ... */
const SYMBOL_ACCENTS: Record<string, string> = { '"': '̈', "'": '́', '`': '̀', '^': '̂', '~': '̃', '=': '̄', '.': '̇' };
/** Characters escaped by a backslash that print themselves. */
const ESCAPED = new Set(['%', '&', '$', '#', '_', '{', '}', '@']);
/** babel's German shorthands: "a is ä, "s is ß. */
const GERMAN: Record<string, string> = { a: 'ä', o: 'ö', u: 'ü', A: 'Ä', O: 'Ö', U: 'Ü', s: 'ß', z: 'ß', '`': '„', "'": '“', '<': '«', '>': '»' };

const MATH_ENVIRONMENTS = new Set([
  'equation',
  'equation*',
  'align',
  'align*',
  'alignat',
  'alignat*',
  'gather',
  'gather*',
  'multline',
  'multline*',
  'eqnarray',
  'eqnarray*',
  'math',
  'displaymath',
  'flalign',
  'flalign*',
]);
const SKIPPED_ENVIRONMENTS = new Set(['tikzpicture', 'comment', 'filecontents', 'filecontents*']);

const isLetter = (char: string | undefined): boolean => char !== undefined && /[A-Za-z@]/.test(char);
const isSpace = (char: string | undefined): boolean => char === ' ' || char === '\t' || char === '\n' || char === '\r';

export function projectLatex(source: string, base = 0): Projection {
  const out = new Builder(base);
  let i = 0;
  const n = source.length;

  /** Index after the group that starts at `at` (a `{`), or `at` when there is none. */
  const skipGroup = (at: number): number => {
    let j = at;
    while (j < n && isSpace(source[j])) j++;
    const open = source[j];
    const close = open === '{' ? '}' : open === '[' ? ']' : null;
    if (!close) return at;
    let depth = 0;
    for (; j < n; j++) {
      const char = source[j];
      if (char === '\\') {
        j++;
        continue;
      }
      if (char === open) depth++;
      else if (char === close && --depth === 0) return j + 1;
    }
    return n;
  };
  const skipOptional = (at: number): number => {
    let j = at;
    while (j < n && isSpace(source[j]) && source[j] !== '\n') j++;
    return source[j] === '[' ? skipGroup(j) : at;
  };
  /** Skips maths up to `close`, emitting one space. */
  const skipMath = (from: number, close: string): number => {
    const found = source.indexOf(close, from);
    const to = found < 0 ? n : found + close.length;
    out.push(' ', i, to);
    return to;
  };
  /**
   * Inline maths keeps its plain letters, digits and signs, the way the PDF
   * shows them (`$p$-value`, `below $0.01$`); commands, braces, `^` and `_`
   * are left out.
   */
  const inlineMath = (from: number, close: string): number => {
    const found = source.indexOf(close, from);
    const end = found < 0 ? n : found;
    const to = found < 0 ? n : found + close.length;
    const start = out.length;
    for (let j = from; j < end; j++) {
      const c = source[j]!;
      if (c === '\\') {
        // A command name, or the one sign after the backslash, is left out.
        j++;
        if (/[A-Za-z]/.test(source[j] ?? '')) while (j + 1 < end && /[A-Za-z]/.test(source[j + 1]!)) j++;
        continue;
      }
      if (isSpace(c)) out.push(' ', j, j + 1);
      else if (/[\p{L}\p{N}.,;:!?+\-=<>()[\]/|']/u.test(c)) out.push(c, j, j + 1);
    }
    if (out.length === start) out.push(' ', i, to);
    return to;
  };

  while (i < n) {
    const char = source[i]!;

    if (char === '%') {
      // A comment runs to the end of the line, and takes the line break with it.
      let j = source.indexOf('\n', i);
      j = j < 0 ? n : j + 1;
      while (j < n && (source[j] === ' ' || source[j] === '\t')) j++;
      i = j;
      continue;
    }

    if (isSpace(char)) {
      let j = i;
      while (j < n && isSpace(source[j])) j++;
      out.push(' ', i, j);
      i = j;
      continue;
    }

    if (char === '$') {
      i = source[i + 1] === '$' ? skipMath(i + 2, '$$') : inlineMath(i + 1, '$');
      continue;
    }

    if (char === '{' || char === '}') {
      i++;
      continue;
    }

    if (char === '~') {
      out.push(' ', i, i + 1);
      i++;
      continue;
    }

    if (char === '&') {
      out.push(' ', i, i + 1);
      i++;
      continue;
    }

    if (char === '-') {
      const dashes = source.startsWith('---', i) ? 3 : source.startsWith('--', i) ? 2 : 1;
      out.push(dashes === 3 ? '—' : dashes === 2 ? '–' : '-', i, i + dashes);
      i += dashes;
      continue;
    }

    if (char === '`' || char === "'") {
      const double = source[i + 1] === char;
      out.push(double ? (char === '`' ? '“' : '”') : char === '`' ? '‘' : '’', i, i + (double ? 2 : 1));
      i += double ? 2 : 1;
      continue;
    }

    if (char === '"') {
      const next = source[i + 1];
      if (next !== undefined && GERMAN[next]) {
        out.push(GERMAN[next], i, i + 2);
        i += 2;
        continue;
      }
      if (next === '-' || next === '"' || next === '|' || next === '=' || next === '~') {
        // Hyphenation hints and joins that print nothing, or a hyphen.
        if (next === '=' || next === '~') out.push('-', i, i + 2);
        i += 2;
        continue;
      }
      out.push('"', i, i + 1);
      i++;
      continue;
    }

    if (char !== '\\') {
      out.push(char, i, i + 1);
      i++;
      continue;
    }

    // ---- a backslash ----
    const next = source[i + 1];
    if (next === undefined) {
      i++;
      continue;
    }
    if (next === '\\') {
      const end = skipOptional(i + 2);
      out.push(' ', i, end);
      i = end;
      continue;
    }
    if (next === '(' || next === '[') {
      i = next === '(' ? inlineMath(i + 2, '\\)') : skipMath(i + 2, '\\]');
      continue;
    }
    if (ESCAPED.has(next)) {
      out.push(next, i, i + 2);
      i += 2;
      continue;
    }
    if (next === ' ' || next === ',' || next === ';' || next === ':' || next === '!' || next === '>' || next === '\n') {
      out.push(' ', i, i + 2);
      i += 2;
      continue;
    }
    if (next === '-' || next === '/') {
      i += 2;
      continue;
    }
    if (SYMBOL_ACCENTS[next]) {
      const accent = SYMBOL_ACCENTS[next];
      const { letter, end } = accentTarget(source, i + 2);
      if (letter) out.push(`${letter}${accent}`.normalize('NFC'), i, end);
      i = end;
      continue;
    }
    if (!isLetter(next)) {
      i += 2;
      continue;
    }

    let j = i + 1;
    while (j < n && isLetter(source[j])) j++;
    const name = source.slice(i + 1, j);
    const starred = source[j] === '*';
    if (starred) j++;

    if (LETTER_ACCENTS[name] && name.length === 1) {
      const { letter, end } = accentTarget(source, j);
      if (letter) {
        out.push(`${letter}${LETTER_ACCENTS[name]}`.normalize('NFC'), i, end);
        i = end;
        continue;
      }
    }

    if (name === 'begin' || name === 'end') {
      const groupEnd = skipGroup(j);
      const env = source.slice(j, groupEnd).replace(/^\s*\{|\}\s*$/g, '').trim();
      if (name === 'begin' && (MATH_ENVIRONMENTS.has(env) || SKIPPED_ENVIRONMENTS.has(env))) {
        const close = `\\end{${env}}`;
        const found = source.indexOf(close, groupEnd);
        const to = found < 0 ? n : found + close.length;
        out.push(' ', i, to);
        i = to;
        continue;
      }
      out.push(' ', i, groupEnd);
      i = skipOptional(groupEnd);
      continue;
    }

    const symbol = SYMBOLS[name];
    if (symbol !== undefined) {
      out.push(symbol, i, j);
      i = j;
      // A control word swallows the spaces after it ("\\ss e" is "ße"); "{}" ends it without a space.
      if (source[i] === '{' && source[i + 1] === '}') i += 2;
      else while (i < n && (source[i] === ' ' || source[i] === '\t')) i++;
      continue;
    }

    const drop = DROP_ARGS[name];
    if (drop !== undefined) {
      let end = skipOptional(j);
      for (let arg = 0; arg < drop; arg++) end = skipOptional(skipGroup(end));
      out.push(' ', i, end);
      i = end;
      continue;
    }

    if (SKIP_FIRST.has(name)) {
      i = skipGroup(skipOptional(j));
      continue;
    }

    // Any other command: its name prints nothing; an optional argument is
    // dropped, and what is in its braces is read as text.
    i = skipOptional(j);
    // TeX swallows the spaces after a control word.
    while (i < n && (source[i] === ' ' || source[i] === '\t')) i++;
  }
  return out.result();
}

function accentTarget(source: string, at: number): { letter: string | null; end: number } {
  let j = at;
  if (source[j] === '{') {
    const close = source.indexOf('}', j);
    if (close < 0) return { letter: null, end: source.length };
    let inner = source.slice(j + 1, close).trim();
    if (inner === '\\i') inner = 'i';
    if (inner === '\\j') inner = 'j';
    return { letter: inner.length > 0 ? inner : null, end: close + 1 };
  }
  while (source[j] === ' ') j++;
  if ((source.startsWith('\\i', j) || source.startsWith('\\j', j)) && !isLetter(source[j + 2])) {
    let end = j + 2;
    while (source[end] === ' ' || source[end] === '\t') end++;
    return { letter: source[j + 1]!, end };
  }
  const letter = source[j];
  return letter && /\p{L}/u.test(letter) ? { letter, end: j + 1 } : { letter: null, end: at };
}

class Builder {
  readonly #base: number;
  #text = '';
  readonly #start: number[] = [];
  readonly #end: number[] = [];

  constructor(base: number) {
    this.#base = base;
  }

  /** Characters written so far. */
  get length(): number {
    return this.#text.length;
  }

  push(text: string, from: number, to: number): void {
    if (text === ' ') {
      // Runs of space-like things become one space that covers them all.
      if (this.#text.length === 0) return;
      if (this.#text.endsWith(' ')) {
        this.#end[this.#end.length - 1] = this.#base + to;
        return;
      }
    }
    for (const char of text) {
      this.#text += char;
      for (let unit = 0; unit < char.length; unit++) {
        this.#start.push(this.#base + from);
        this.#end.push(this.#base + to);
      }
    }
  }

  result(): Projection {
    return { text: this.#text, start: this.#start, end: this.#end };
  }
}
