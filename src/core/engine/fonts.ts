import { stripComments } from '../latex/deps';

/**
 * Packages that replace the default text font with one that ships as scalable
 * outlines. A document that loads one of them does not need the large cm-super
 * font bundle even when it asks for T1 encoding.
 */
const OUTLINE_FONT_PACKAGES = [
  'lmodern', 'newtxtext', 'newtxmath', 'newpxtext', 'newpxmath', 'libertine', 'libertinus', 'mathpazo', 'mathptmx',
  'times', 'palatino', 'helvet', 'charter', 'XCharter', 'kpfonts', 'fourier', 'stix', 'stix2', 'tgtermes',
  'tgpagella', 'tgheros', 'tgbonum', 'tgschola', 'cmbright', 'bookman', 'newcent', 'roboto', 'inconsolata',
  'fontspec', 'unicode-math',
];

const USEPACKAGE = /\\(?:usepackage|RequirePackage)\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}/g;

/**
 * Tells whether a document needs the cm-super bundle: it asks for T1 (or TS1)
 * encoded Computer Modern and loads no package that brings outline fonts.
 * Without the bundle pdfTeX would look for bitmap fonts, which cannot be
 * generated in the browser, and stop with "Font ecrm1000 not found".
 */
export function needsCmSuper(preamble: string): boolean {
  const source = stripComments(preamble);
  let wantsT1 = false;
  let hasOutlineFont = false;
  for (const match of source.matchAll(USEPACKAGE)) {
    const options = (match[1] ?? '').split(',').map((option) => option.trim());
    const packages = (match[2] ?? '').split(',').map((name) => name.trim());
    if (packages.includes('fontenc') && options.some((option) => /^(T1|TS1|T2A|T2B|T2C|X2|LGR)$/.test(option))) wantsT1 = true;
    if (packages.includes('textcomp')) wantsT1 = true;
    if (packages.some((name) => OUTLINE_FONT_PACKAGES.includes(name))) hasOutlineFont = true;
  }
  return wantsT1 && !hasOutlineFont;
}

/** Recognises the error pdfTeX prints when a bitmap-only font is missing. */
export function isMissingBitmapFont(text: string): boolean {
  return /Font (?:ec|tc|la|lb|lc|rx)[a-z]{2,4}\d{3,4} at \d+ not found/.test(text);
}

/**
 * Removes pdfTeX's warnings about its own font map from a log ("fontmap entry
 * for ... already exists, duplicates ignored" and the like). The engine's map
 * lists every font several times, so each compile prints a few thousand of
 * them, close to a megabyte that says nothing about the document. Everything
 * else is kept as it is.
 */
export function dropFontMapNoise(log: string, wrapWidth = 79): string {
  if (!log.includes('pdfTeX warning:')) return log;
  const lines = log.split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.startsWith('pdfTeX warning:')) {
      kept.push(lines[i]!);
      continue;
    }
    // TeX breaks a long line after exactly `wrapWidth` characters, so the
    // warning goes on for as long as the lines are that long.
    let end = i;
    while (lines[end]!.length === wrapWidth && end + 1 < lines.length && end - i < 8) end++;
    const whole = lines.slice(i, end + 1).join('');
    if (!/^pdfTeX warning: \S+ \(file \S*\/updmap\/pdftex\.map\): /.test(whole)) {
      kept.push(lines[i]!);
      continue;
    }
    i = end;
    while (i + 1 < lines.length && lines[i + 1]!.trim() === '') i++;
  }
  return kept.join('\n');
}
