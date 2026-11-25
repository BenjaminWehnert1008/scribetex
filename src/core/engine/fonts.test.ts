import { describe, expect, it } from 'vitest';
import { dropFontMapNoise, isMissingBitmapFont, needsCmSuper } from './fonts';

describe('needsCmSuper', () => {
  it('is needed for T1 Computer Modern without an outline font package', () => {
    expect(needsCmSuper('\\documentclass{article}\n\\usepackage[T1]{fontenc}')).toBe(true);
    expect(needsCmSuper('\\usepackage[utf8]{inputenc}\\usepackage[ T1 ]{fontenc}')).toBe(true);
    expect(needsCmSuper('\\usepackage{textcomp}')).toBe(true);
  });

  it('is not needed with lmodern or another outline font', () => {
    expect(needsCmSuper('\\usepackage[T1]{fontenc}\n\\usepackage{lmodern}')).toBe(false);
    expect(needsCmSuper('\\usepackage[T1]{fontenc}\\usepackage{amsmath,newtxtext}')).toBe(false);
  });

  it('is not needed for the default OT1 encoding or a commented-out fontenc', () => {
    expect(needsCmSuper('\\documentclass{article}\\usepackage{amsmath}')).toBe(false);
    expect(needsCmSuper('% \\usepackage[T1]{fontenc}')).toBe(false);
  });
});

describe('isMissingBitmapFont', () => {
  it('recognises the pdfTeX message', () => {
    expect(isMissingBitmapFont('!pdfTeX error: /bin/busytex (file ecbx1095): Font ecbx1095 at 600 not found')).toBe(true);
    expect(isMissingBitmapFont('Font tcrm1000 at 600 not found')).toBe(true);
    expect(isMissingBitmapFont("LaTeX Error: File `tikz.sty' not found.")).toBe(false);
  });
});

describe('dropFontMapNoise', () => {
  const noise = (name: string): string =>
    [
      'pdfTeX warning: /bin/busytex (file /texlive/texmf-dist/texmf-var/fonts/map/pdft',
      `ex/updmap/pdftex.map): fontmap entry for \`${name}' already exists, duplica`,
      'tes ignored',
      '',
      '',
    ].join('\n');

  it('removes the duplicate font map warnings and nothing else', () => {
    // The last warning is followed by the rest of the page's output without a blank line.
    const last = noise('uzdr').trimEnd() + '\n';
    const slanted = [
      'pdfTeX warning: /bin/busytex (file /texlive/texmf-dist/texmf-var/fonts/map/pdft',
      "ex/updmap/pdftex.map): invalid entry for `tmro108r': SlantFont/ExtendFont can b",
      'e used only with embedded Type1 fonts',
      '',
      '',
    ].join('\n');
    const log = ['[1', '', '{/texlive/texmf-dist/texmf-var/fonts/map/pdftex/updmap/pdftex.map', '', '', noise('ts1-lmr10') + noise('phvr8r') + slanted + last + '}] (./main.aux)', 'Output written on main.pdf (1 page, 100 bytes).'].join('\n');
    const cleaned = dropFontMapNoise(log);
    expect(cleaned).not.toContain('fontmap entry');
    expect(cleaned).not.toContain('pdfTeX warning');
    expect(cleaned).toContain('pdftex.map');
    expect(cleaned).toContain('}] (./main.aux)');
    expect(cleaned).toContain('Output written on main.pdf');
  });

  it('keeps other pdfTeX warnings', () => {
    const log = ['pdfTeX warning (dest): name{fig:a} has been referenced but does not exist, replaced by a fixed one', '', noise('usyr') + 'pdfTeX warning: /bin/busytex (file ./plot.pdf): PDF inclusion: found PDF version <1.7>, but at most version <1.5> allowed', '', 'done'].join('\n');
    const cleaned = dropFontMapNoise(log);
    expect(cleaned).toContain('has been referenced but does not exist');
    expect(cleaned).toContain('PDF inclusion: found PDF version');
    expect(cleaned).not.toContain('usyr');
    expect(cleaned.endsWith('done')).toBe(true);
  });

  it('returns a log without such warnings untouched', () => {
    const log = 'This is pdfTeX\n\n(./main.tex)\n';
    expect(dropFontMapNoise(log)).toBe(log);
  });
});
