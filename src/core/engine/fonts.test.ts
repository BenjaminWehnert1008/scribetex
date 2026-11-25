import { describe, expect, it } from 'vitest';
import { isMissingBitmapFont, needsCmSuper } from './fonts';

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
