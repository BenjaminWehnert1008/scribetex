/**
 * Office Math (OMML, the m:* elements Word's equation editor writes) to LaTeX.
 *
 * Written from the element list in ECMA-376 Part 1, section 22.1. Every
 * structure Word's equation ribbon offers is mapped; unknown elements fall
 * back to their content so no text is lost.
 */
import { GREEK } from './latex-text';
import { child, childrenNamed, elements, textOf, val, type XmlElement } from './xml';

/** Characters inside equations. Letters and digits pass through unchanged. */
const MATH_SYMBOLS: Record<string, string> = {
  '±': '\\pm', '∓': '\\mp', '×': '\\times', '÷': '\\div', '·': '\\cdot', '⋅': '\\cdot', '∗': '\\ast', '∘': '\\circ',
  '∙': '\\bullet', '−': '-', '–': '-', '≤': '\\leq', '≥': '\\geq', '≦': '\\leqq', '≧': '\\geqq', '≠': '\\neq',
  '≈': '\\approx', '≡': '\\equiv', '≅': '\\cong', '∼': '\\sim', '≃': '\\simeq', '∝': '\\propto', '≪': '\\ll',
  '≫': '\\gg', '∞': '\\infty', '∂': '\\partial', '∇': '\\nabla', '∆': '\\Delta', '∈': '\\in', '∉': '\\notin',
  '∋': '\\ni', '⊂': '\\subset', '⊃': '\\supset', '⊆': '\\subseteq', '⊇': '\\supseteq', '∪': '\\cup', '∩': '\\cap',
  '∅': '\\emptyset', '∀': '\\forall', '∃': '\\exists', '∄': '\\nexists', '¬': '\\neg', '∧': '\\wedge', '∨': '\\vee',
  '⊕': '\\oplus', '⊗': '\\otimes', '⊥': '\\perp', '∥': '\\parallel', '∠': '\\angle', '°': '^{\\circ}',
  '′': "'", '″': "''", '‴': "'''", '→': '\\rightarrow', '←': '\\leftarrow', '↔': '\\leftrightarrow',
  '⇒': '\\Rightarrow', '⇐': '\\Leftarrow', '⇔': '\\Leftrightarrow', '↦': '\\mapsto', '↑': '\\uparrow',
  '↓': '\\downarrow', '⟶': '\\longrightarrow', '⟹': '\\Longrightarrow', '…': '\\ldots', '⋯': '\\cdots',
  '⋮': '\\vdots', '⋱': '\\ddots', 'ℝ': '\\mathbb{R}', 'ℕ': '\\mathbb{N}', 'ℤ': '\\mathbb{Z}', 'ℚ': '\\mathbb{Q}',
  'ℂ': '\\mathbb{C}', 'ℙ': '\\mathbb{P}', 'ℏ': '\\hbar', 'ℓ': '\\ell', '℘': '\\wp', 'ℑ': '\\Im', 'ℜ': '\\Re',
  'ℵ': '\\aleph', '∑': '\\sum', '∏': '\\prod', '∫': '\\int', '∬': '\\iint', '∭': '\\iiint', '∮': '\\oint',
  '√': '\\surd', '∴': '\\therefore', '∵': '\\because', '⟨': '\\langle', '⟩': '\\rangle', '⌈': '\\lceil',
  '⌉': '\\rceil', '⌊': '\\lfloor', '⌋': '\\rfloor', '‖': '\\|', '∣': '\\mid', '∤': '\\nmid', '≺': '\\prec',
  '≻': '\\succ', '⊢': '\\vdash', '⊨': '\\models', '□': '\\square', '△': '\\triangle', '★': '\\star',
  '⁡': '', '⁢': '', '⁣': '', '⁤': '', '​': '', ' ': '~', ' ': '\\,', ' ': '\\:',
  ' ': '\\quad ', ' ': '\\enspace ', '#': '\\#', $: '\\$', '%': '\\%', '&': '\\&', _: '\\_', '{': '\\{',
  '}': '\\}', '\\': '\\backslash', '~': '\\sim', '^': '\\wedge',
};

const NARY: Record<string, string> = {
  '∑': '\\sum', '∏': '\\prod', '∐': '\\coprod', '∫': '\\int', '∬': '\\iint', '∭': '\\iiint', '∮': '\\oint',
  '∯': '\\oint', '⋃': '\\bigcup', '⋂': '\\bigcap', '⋁': '\\bigvee', '⋀': '\\bigwedge', '⨁': '\\bigoplus',
  '⨂': '\\bigotimes', '⨀': '\\bigodot', '⨄': '\\biguplus',
};

const ACCENTS: Record<string, string> = {
  '̂': '\\hat', '̃': '\\tilde', '̄': '\\bar', '̅': '\\overline', '̇': '\\dot',
  '̈': '\\ddot', '⃛': '\\dddot', '⃗': '\\vec', '́': '\\acute', '̀': '\\grave',
  '̆': '\\breve', '̌': '\\check', '⃖': '\\overleftarrow', '⃡': '\\overleftrightarrow',
  '⏞': '\\overbrace', '⏟': '\\underbrace', '^': '\\hat', '~': '\\tilde', '¯': '\\bar', '\u203e': '\\bar', '→': '\\vec',
};

const DELIMITERS: Record<string, string> = {
  '(': '(', ')': ')', '[': '[', ']': ']', '{': '\\{', '}': '\\}', '|': '|', '‖': '\\|', '⟨': '\\langle',
  '⟩': '\\rangle', '〈': '\\langle', '〉': '\\rangle', '⌊': '\\lfloor', '⌋': '\\rfloor', '⌈': '\\lceil',
  '⌉': '\\rceil', '/': '/', '\\': '\\backslash', '⟦': '[\\![', '⟧': ']\\!]',
};

/** Function names LaTeX knows as commands; others become \operatorname. */
const FUNCTIONS = new Set([
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'coth', 'log',
  'ln', 'lg', 'exp', 'lim', 'liminf', 'limsup', 'max', 'min', 'sup', 'inf', 'det', 'dim', 'ker', 'deg', 'gcd',
  'arg', 'hom', 'Pr',
]);

export interface MathStats {
  /** Characters with no LaTeX form, kept as \text{?}. */
  unknown: number;
}

class Writer {
  constructor(readonly stats: MathStats) {}

  /** The LaTeX for the children of an element (m:e, m:num, m:oMath ...). */
  seq(node: XmlElement | undefined): string {
    if (!node) return '';
    let out = '';
    for (const item of elements(node)) out = join(out, this.one(item));
    return out.trim();
  }

  one(node: XmlElement): string {
    switch (node.name) {
      case 'm:r':
        return this.run(node);
      case 'm:f':
        return this.fraction(node);
      case 'm:sSup':
        return `${this.base(child(node, 'm:e'))}^{${this.seq(child(node, 'm:sup'))}}`;
      case 'm:sSub':
        return `${this.base(child(node, 'm:e'))}_{${this.seq(child(node, 'm:sub'))}}`;
      case 'm:sSubSup':
        return `${this.base(child(node, 'm:e'))}_{${this.seq(child(node, 'm:sub'))}}^{${this.seq(child(node, 'm:sup'))}}`;
      case 'm:sPre':
        return `{}_{${this.seq(child(node, 'm:sub'))}}^{${this.seq(child(node, 'm:sup'))}}${this.base(child(node, 'm:e'))}`;
      case 'm:rad':
        return this.radical(node);
      case 'm:nary':
        return this.nary(node);
      case 'm:d':
        return this.delimiter(node);
      case 'm:func':
        return this.func(node);
      case 'm:acc':
        return this.accent(node);
      case 'm:bar': {
        const pos = val(child(node, 'm:barPr'), 'm:pos', 'm:val') ?? 'bot';
        return `${pos === 'top' ? '\\overline' : '\\underline'}{${this.seq(child(node, 'm:e'))}}`;
      }
      case 'm:groupChr':
        return this.groupChar(node);
      case 'm:limLow':
        return this.limit(node, 'low');
      case 'm:limUpp':
        return this.limit(node, 'upp');
      case 'm:m':
        return this.matrix(node);
      case 'm:eqArr': {
        const rows = childrenNamed(node, 'm:e').map((row) => this.seq(row));
        const aligned = rows.some((row) => row.includes('&'));
        const env = aligned ? 'aligned' : 'gathered';
        return `\\begin{${env}}${rows.join(' \\\\ ')}\\end{${env}}`;
      }
      case 'm:borderBox':
        return `\\boxed{${this.seq(child(node, 'm:e'))}}`;
      case 'm:box':
        return this.seq(child(node, 'm:e'));
      case 'm:phant': {
        const props = child(node, 'm:phantPr');
        const show = val(props, 'm:show', 'm:val');
        const inner = this.seq(child(node, 'm:e'));
        return show === '1' || show === 'on' || show === 'true' ? inner : `\\phantom{${inner}}`;
      }
      case 'm:oMath':
        return this.seq(node);
      case 'm:e':
      case 'm:num':
      case 'm:den':
      case 'm:sub':
      case 'm:sup':
      case 'm:deg':
      case 'm:lim':
      case 'm:fName':
        return this.seq(node);
      default:
        // Properties (…Pr), control characters and Word-only wrappers.
        if (node.name.endsWith('Pr') || node.name === 'm:ctrlPr' || node.name === 'w:bookmarkStart' || node.name === 'w:bookmarkEnd') return '';
        if (node.name === 'w:r') return this.text(textOf(child(node, 'w:t')), false);
        if (node.name === 'mc:AlternateContent') return this.seq(child(node, 'mc:Choice') ?? child(node, 'mc:Fallback'));
        return this.seq(node);
    }
  }

  /** A base that takes a script: wrapped in braces unless it is a single symbol. */
  base(node: XmlElement | undefined): string {
    const inner = this.seq(node);
    if (inner === '') return '{}';
    if (/^([A-Za-z0-9]|\\[A-Za-z]+|\\[A-Za-z]+\{[A-Za-z0-9]\})$/.test(inner)) return inner;
    return `{${inner}}`;
  }

  run(node: XmlElement): string {
    const props = child(node, 'm:rPr');
    const plain = val(props, 'm:sty', 'm:val') === 'p' || child(props, 'm:nor') !== undefined;
    const script = val(props, 'm:scr', 'm:val');
    let out = '';
    for (const item of elements(node)) {
      if (item.name === 'm:t') out += this.text(textOf(item), plain);
      else if (item.name === 'w:br') out += ' \\\\ ';
    }
    if (script === 'double-struck') return `\\mathbb{${out}}`;
    if (script === 'script') return `\\mathcal{${out}}`;
    if (script === 'fraktur') return `\\mathfrak{${out}}`;
    return out;
  }

  /** Math text: words in an upright run become \mathrm or a function name. */
  text(raw: string, plain: boolean): string {
    if (plain) {
      const trimmed = raw.trim();
      if (FUNCTIONS.has(trimmed)) return `\\${trimmed} `;
      if (/^[A-Za-zÀ-ÿ]{2,}$/.test(trimmed)) return `\\mathrm{${trimmed}}`;
      if (/[A-Za-zÀ-ÿ]{2,}\s+[A-Za-zÀ-ÿ]/.test(trimmed)) return `\\text{${trimmed.replace(/[\\{}$&#%_^~]/g, '')}}`;
    }
    let out = '';
    for (const ch of raw) {
      out = join(out, this.char(ch));
    }
    return out;
  }

  char(ch: string): string {
    if (/^[A-Za-z0-9+\-=()[\]<>/!?.,;:'|*@]$/.test(ch)) return ch;
    if (ch === ' ') return ' ';
    const code0 = ch.codePointAt(0)!;
    // Unicode spaces of different widths.
    if (code0 >= 0x2000 && code0 <= 0x200a) return code0 <= 0x2001 || code0 === 0x2003 ? '\\quad ' : code0 <= 0x2006 ? '\\; ' : '\\, ';
    const symbol = MATH_SYMBOLS[ch];
    if (symbol !== undefined) return symbol;
    const greek = GREEK[ch];
    if (greek !== undefined) return greek;
    const code = ch.codePointAt(0)!;
    // Mathematical alphanumeric symbols (italic x, bold A ...) fold to the plain letter.
    if (code >= 0x1d400 && code <= 0x1d7ff) {
      const plain = ch.normalize('NFKC');
      if (plain !== ch) return this.char(plain);
    }
    if (code === 0x210e) return 'h';
    if (/^\p{L}$/u.test(ch) && code < 0x250) return `\\text{${ch}}`;
    this.stats.unknown++;
    return '\\text{?}';
  }

  fraction(node: XmlElement): string {
    const type = val(child(node, 'm:fPr'), 'm:type', 'm:val') ?? 'bar';
    const num = this.seq(child(node, 'm:num'));
    const den = this.seq(child(node, 'm:den'));
    if (type === 'lin') return `${wrapIfLong(num)}/${wrapIfLong(den)}`;
    if (type === 'noBar') return `\\genfrac{}{}{0pt}{}{${num}}{${den}}`;
    if (type === 'skw') return `{}^{${num}}\\!/\\!{}_{${den}}`;
    return `\\frac{${num}}{${den}}`;
  }

  radical(node: XmlElement): string {
    const hide = val(child(node, 'm:radPr'), 'm:degHide', 'm:val');
    const degree = hide === '1' || hide === 'on' ? '' : this.seq(child(node, 'm:deg'));
    const inner = this.seq(child(node, 'm:e'));
    return degree ? `\\sqrt[${degree}]{${inner}}` : `\\sqrt{${inner}}`;
  }

  nary(node: XmlElement): string {
    const props = child(node, 'm:naryPr');
    const chr = val(props, 'm:chr', 'm:val') ?? '∫';
    const command = NARY[chr] ?? (MATH_SYMBOLS[chr] || '\\int');
    const on = (name: string) => {
      const value = val(props, name, 'm:val');
      return value === '1' || value === 'on' || value === 'true';
    };
    const location = val(props, 'm:limLoc', 'm:val');
    const integral = /int$/.test(command);
    let out = command;
    if (location === 'undOvr' && integral) out += '\\limits';
    if (location === 'subSup' && !integral) out += '\\nolimits';
    const sub = on('m:subHide') ? '' : this.seq(child(node, 'm:sub'));
    const sup = on('m:supHide') ? '' : this.seq(child(node, 'm:sup'));
    if (sub) out += `_{${sub}}`;
    if (sup) out += `^{${sup}}`;
    const body = this.seq(child(node, 'm:e'));
    return body ? `${out} ${body}` : out;
  }

  delimiter(node: XmlElement): string {
    const props = child(node, 'm:dPr');
    const begin = val(props, 'm:begChr', 'm:val') ?? '(';
    const end = val(props, 'm:endChr', 'm:val') ?? ')';
    const separator = val(props, 'm:sepChr', 'm:val') ?? '|';
    const parts = childrenNamed(node, 'm:e').map((part) => this.seq(part));
    const left = delimiter(begin);
    const right = delimiter(end);
    const middle = separator === '|' ? ' \\middle| ' : separator === ',' ? ', ' : ` ${delimiter(separator)} `;
    const inner = parts.join(parts.length > 1 ? middle : '');
    // A single matrix inside parentheses or brackets reads best as pmatrix/bmatrix.
    const matrix = /^\\begin\{matrix\}([\s\S]*)\\end\{matrix\}$/.exec(inner);
    if (matrix && parts.length === 1) {
      const env = begin === '(' && end === ')' ? 'pmatrix' : begin === '[' && end === ']' ? 'bmatrix' : begin === '|' && end === '|' ? 'vmatrix' : null;
      if (env) return `\\begin{${env}}${matrix[1]}\\end{${env}}`;
    }
    if (begin === '{' && end === '' && /\\begin\{(gathered|aligned|matrix)\}/.test(inner)) {
      return `\\begin{cases}${inner.replace(/\\begin\{(gathered|aligned|matrix)\}|\\end\{(gathered|aligned|matrix)\}/g, '')}\\end{cases}`;
    }
    return `\\left${left} ${inner} \\right${right}`;
  }

  func(node: XmlElement): string {
    const nameNode = child(node, 'm:fName');
    let name = this.seq(nameNode);
    const plainName = textOf(nameNode).trim();
    if (/^\\mathrm\{([A-Za-z]+)\}$/.test(name)) {
      const word = name.slice(8, -1);
      name = FUNCTIONS.has(word) ? `\\${word}` : `\\operatorname{${word}}`;
    } else if (/^[A-Za-z]{2,}$/.test(name)) {
      name = FUNCTIONS.has(name) ? `\\${name}` : `\\operatorname{${name}}`;
    } else if (name === '' && plainName) name = `\\operatorname{${plainName}}`;
    const argument = this.seq(child(node, 'm:e'));
    return `${name}{${argument}}`;
  }

  accent(node: XmlElement): string {
    const chr = val(child(node, 'm:accPr'), 'm:chr', 'm:val') ?? '̂';
    const inner = this.seq(child(node, 'm:e'));
    let command = ACCENTS[chr] ?? '\\hat';
    const long = inner.replace(/\\[A-Za-z]+/g, 'x').length > 1;
    if (long && command === '\\hat') command = '\\widehat';
    if (long && command === '\\tilde') command = '\\widetilde';
    if (long && command === '\\bar') command = '\\overline';
    if (long && command === '\\vec') command = '\\overrightarrow';
    return `${command}{${inner}}`;
  }

  groupChar(node: XmlElement): string {
    const props = child(node, 'm:groupChrPr');
    const chr = val(props, 'm:chr', 'm:val') ?? '⏟';
    const pos = val(props, 'm:pos', 'm:val') ?? 'bot';
    const inner = this.seq(child(node, 'm:e'));
    if (chr === '⏞' || (pos === 'top' && chr === '⏟')) return `\\overbrace{${inner}}`;
    if (chr === '⏟') return `\\underbrace{${inner}}`;
    const symbol = MATH_SYMBOLS[chr] ?? '\\rightarrow';
    return pos === 'top' ? `\\overset{${symbol}}{${inner}}` : `\\underset{${symbol}}{${inner}}`;
  }

  limit(node: XmlElement, where: 'low' | 'upp'): string {
    const base = this.seq(child(node, 'm:e'));
    const limit = this.seq(child(node, 'm:lim'));
    if (where === 'low' && /^\\(lim|max|min|sup|inf|liminf|limsup|operatorname\{[^}]*\})\s*$/.test(base)) return `${base.trim()}_{${limit}}`;
    if (/^\\(underbrace|overbrace)\{/.test(base)) return `${base}${where === 'low' ? '_' : '^'}{${limit}}`;
    return where === 'low' ? `\\underset{${limit}}{${base}}` : `\\overset{${limit}}{${base}}`;
  }

  matrix(node: XmlElement): string {
    const rows = childrenNamed(node, 'm:mr').map((row) =>
      childrenNamed(row, 'm:e')
        .map((cell) => this.seq(cell))
        .join(' & '),
    );
    return `\\begin{matrix}${rows.join(' \\\\ ')}\\end{matrix}`;
  }
}

function delimiter(chr: string): string {
  if (chr === '') return '.';
  return DELIMITERS[chr] ?? '.';
}

function wrapIfLong(text: string): string {
  return /^[A-Za-z0-9]$/.test(text) || /^\\[A-Za-z]+$/.test(text) ? text : `(${text})`;
}

/** Joins two pieces of LaTeX so that a command name never runs into a letter. */
function join(left: string, right: string): string {
  if (right === '') return left;
  if (/\\[A-Za-z]+$/.test(left) && /^[A-Za-z]/.test(right)) return `${left} ${right}`;
  return left + right;
}

/** Converts one m:oMath or m:oMathPara element to LaTeX (without $ or \[ \]). */
export function ommlToLatex(node: XmlElement, stats: MathStats = { unknown: 0 }): string {
  const writer = new Writer(stats);
  const out = node.name === 'm:oMathPara' ? childrenNamed(node, 'm:oMath').map((math) => writer.seq(math)).join(' \\\\ ') : writer.seq(node);
  return tidy(out);
}

/** The equations inside an m:oMathPara, one per line. */
export function ommlParagraph(node: XmlElement, stats: MathStats = { unknown: 0 }): string[] {
  const writer = new Writer(stats);
  return childrenNamed(node, 'm:oMath')
    .map((math) => tidy(writer.seq(math)))
    .filter((line) => line !== '');
}

function tidy(latex: string): string {
  return latex.replace(/[ \t]+/g, ' ').replace(/ ?(\\\\) ?/g, ' $1 ').trim();
}
