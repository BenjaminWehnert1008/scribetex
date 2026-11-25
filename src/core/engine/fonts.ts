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
