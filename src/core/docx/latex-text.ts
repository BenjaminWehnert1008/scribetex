/**
 * Turns plain text from a Word file into text pdfLaTeX can typeset.
 *
 * The generated preamble loads utf8 input with T1 fonts, which covers the
 * Latin letters of most European languages directly. Other characters that
 * often appear in Word files (typographic symbols, arrows, Greek letters in
 * running text) are written as LaTeX commands. Anything still unknown would
 * stop the compile with "Unicode character not set up", so it is replaced by
 * a visible marker and counted.
 */

const SPECIAL: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '{': '\\{',
  '}': '\\}',
  $: '\\$',
  '&': '\\&',
  '#': '\\#',
  '%': '\\%',
  _: '\\_',
  '^': '\\textasciicircum{}',
  '~': '\\textasciitilde{}',
  '<': '\\textless{}',
  '>': '\\textgreater{}',
  '|': '\\textbar{}',
};

/** Characters outside Latin-1 and Latin Extended-A that have a text command. */
const TEXT_SYMBOLS: Record<string, string> = {
  '\u00a0': '~',
  '\u2002': '\\enspace{}',
  '\u2003': '\\quad{}',
  '\u2009': '\\,',
  '\u202f': '\\,',
  '\u200b': '',
  '\u200c': '',
  '\u200d': '',
  '\u2060': '',
  '\ufeff': '',
  '\u00ad': '\\-',
  '\u2011': '-',
  '\u2010': '-',
  '\u2012': '--',
  '\u2013': '--',
  '\u2014': '---',
  '\u2015': '---',
  '\u2212': '\\textminus{}',
  '\u2018': '`',
  '\u2019': "'",
  '\u201a': '\\quotesinglbase{}',
  '\u201b': "'",
  '\u201c': '``',
  '\u201d': "''",
  '\u201e': '\\quotedblbase{}',
  '\u201f': "''",
  '\u2039': '\\guilsinglleft{}',
  '\u203a': '\\guilsinglright{}',
  '\u2026': '\\dots{}',
  '\u2022': '\\textbullet{}',
  '\u25cf': '\\textbullet{}',
  '\u00b7': '\\textperiodcentered{}',
  '\u2020': '\\dag{}',
  '\u2021': '\\ddag{}',
  '\u2030': '\\textperthousand{}',
  '\u2032': '$\\prime$',
  '\u2033': '$\\prime\\prime$',
  '\u20ac': '\\texteuro{}',
  '\u2122': '\\texttrademark{}',
  '\u2116': '\\textnumero{}',
  '\u2190': '$\\leftarrow$',
  '\u2192': '$\\rightarrow$',
  '\u2191': '$\\uparrow$',
  '\u2193': '$\\downarrow$',
  '\u2194': '$\\leftrightarrow$',
  '\u21d0': '$\\Leftarrow$',
  '\u21d2': '$\\Rightarrow$',
  '\u21d4': '$\\Leftrightarrow$',
  '\u2248': '$\\approx$',
  '\u2260': '$\\neq$',
  '\u2264': '$\\leq$',
  '\u2265': '$\\geq$',
  '\u221e': '$\\infty$',
  '\u2211': '$\\sum$',
  '\u221a': '$\\surd$',
  '\u2202': '$\\partial$',
  '\u2206': '$\\Delta$',
  '\u2207': '$\\nabla$',
  '\u2208': '$\\in$',
  '\u2209': '$\\notin$',
  '\u2229': '$\\cap$',
  '\u222a': '$\\cup$',
  '\u2282': '$\\subset$',
  '\u2283': '$\\supset$',
  '\u2286': '$\\subseteq$',
  '\u2287': '$\\supseteq$',
  '\u2200': '$\\forall$',
  '\u2203': '$\\exists$',
  '\u2205': '$\\emptyset$',
  '\u2227': '$\\wedge$',
  '\u2228': '$\\vee$',
  '\u00ac': '$\\neg$',
  '\u2261': '$\\equiv$',
  '\u221d': '$\\propto$',
  '\u2245': '$\\cong$',
  '\u223c': '$\\sim$',
  '\u2213': '$\\mp$',
  '\u22c5': '$\\cdot$',
  '\u2218': '$\\circ$',
  '\u2713': '$\\checkmark$',
  '\u2714': '$\\checkmark$',
  '\u2717': '$\\times$',
  '\u25a0': '$\\blacksquare$',
  '\u25a1': '$\\square$',
  '\u2610': '$\\square$',
  '\u2611': '$\\boxtimes$',
  '\u2612': '$\\boxtimes$',
  '\u2605': '$\\bigstar$',
  '\ufb01': 'fi',
  '\ufb02': 'fl',
  '\ufb00': 'ff',
  '\ufb03': 'ffi',
  '\ufb04': 'ffl',
};

/** Greek letters, written as math so they work in any font. */
export const GREEK: Record<string, string> = {
  α: '\\alpha', β: '\\beta', γ: '\\gamma', δ: '\\delta', ε: '\\epsilon', ϵ: '\\epsilon', ζ: '\\zeta', η: '\\eta',
  θ: '\\theta', ϑ: '\\vartheta', ι: '\\iota', κ: '\\kappa', λ: '\\lambda', μ: '\\mu', ν: '\\nu', ξ: '\\xi',
  ο: 'o', π: '\\pi', ϖ: '\\varpi', ρ: '\\rho', ϱ: '\\varrho', σ: '\\sigma', ς: '\\varsigma', τ: '\\tau',
  υ: '\\upsilon', φ: '\\phi', ϕ: '\\phi', χ: '\\chi', ψ: '\\psi', ω: '\\omega',
  Γ: '\\Gamma', Δ: '\\Delta', Θ: '\\Theta', Λ: '\\Lambda', Ξ: '\\Xi', Π: '\\Pi', Σ: '\\Sigma', Υ: '\\Upsilon',
  Φ: '\\Phi', Ψ: '\\Psi', Ω: '\\Omega',
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Χ: 'X',
};

/**
 * Whether pdfLaTeX with utf8 + T1 typesets this character as it is.
 * Latin-1 Supplement and Latin Extended-A are covered, minus a few gaps.
 */
function typesetsDirectly(code: number): boolean {
  if (code >= 0x20 && code < 0x7f) return true;
  if (code >= 0xa1 && code <= 0xff) return code !== 0xad;
  if (code >= 0x100 && code <= 0x17f) return code !== 0x149 && code !== 0x17f;
  // Latin Extended-B and Additional letters that T1 has: Ș ș Ț ț (Romanian).
  return code === 0x218 || code === 0x219 || code === 0x21a || code === 0x21b;
}

export interface EscapeStats {
  /** Characters replaced by a marker because pdfLaTeX cannot typeset them. */
  unknown: Map<string, number>;
}

export function newEscapeStats(): EscapeStats {
  return { unknown: new Map() };
}

/** Escapes text for LaTeX running text. */
export function escapeText(text: string, stats?: EscapeStats): string {
  let out = '';
  for (const ch of text.normalize('NFC')) {
    const special = SPECIAL[ch];
    if (special !== undefined) {
      out += special;
      continue;
    }
    const code = ch.codePointAt(0)!;
    if (code < 0x20) {
      out += code === 0x09 ? ' ' : '';
      continue;
    }
    if (typesetsDirectly(code)) {
      out += ch;
      continue;
    }
    if (code >= 0x2000 && code <= 0x200a) {
      out += code <= 0x2001 || code === 0x2003 ? '\\quad{}' : code === 0x2002 ? '\\enspace{}' : '\\,';
      continue;
    }
    const symbol = TEXT_SYMBOLS[ch];
    if (symbol !== undefined) {
      out += symbol;
      continue;
    }
    const greek = GREEK[ch];
    if (greek !== undefined) {
      out += greek.startsWith('\\') ? `$${greek}$` : greek;
      continue;
    }
    // Private-use characters are symbol-font glyphs (Wingdings bullets and the like).
    if (code >= 0xe000 && code <= 0xf8ff) {
      out += '\\textbullet{}';
      continue;
    }
    if (stats) stats.unknown.set(ch, (stats.unknown.get(ch) ?? 0) + 1);
    out += '\\textbf{?}';
  }
  return out;
}

/** Escapes a URL for \href and \url. */
export function escapeUrl(url: string): string {
  return url.replace(/\\/g, '/').replace(/([%#{}])/g, '\\$1').replace(/\s/g, '%20');
}

/** A label or citation key that LaTeX and BibTeX both accept. */
export function safeKey(raw: string, fallback = 'key'): string {
  const ascii = raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9:._-]+/g, '')
    .replace(/^[^A-Za-z0-9]+/, '');
  return ascii || fallback;
}

/** A file name made from a heading: lower case ASCII words joined by hyphens. */
export function slug(text: string, maxLength = 40): string {
  const words = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  let out = '';
  for (const word of words) {
    const next = out ? `${out}-${word}` : word;
    if (next.length > maxLength) break;
    out = next;
  }
  return out || (words[0]?.slice(0, maxLength) ?? '');
}
