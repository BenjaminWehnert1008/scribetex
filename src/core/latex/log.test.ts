import { describe, expect, it } from 'vitest';
import { explain, parseLog, unwrapLog, PathResolver } from './log';

describe('unwrapLog', () => {
  it('joins lines TeX hard-wrapped at the print width', () => {
    const wrapped = ['x'.repeat(79), 'tail', 'short'].join('\n');
    expect(unwrapLog(wrapped, 79)).toEqual(['x'.repeat(79) + 'tail', 'short']);
  });

  it('leaves logs alone when nothing is wrapped', () => {
    expect(unwrapLog('a\nb\n', 79)).toEqual(['a', 'b', '']);
    expect(unwrapLog(['y'.repeat(79), 'tail'].join('\n'), 0)).toEqual(['y'.repeat(79), 'tail']);
  });
});

describe('PathResolver', () => {
  const known = ['main.tex', 'chapters/intro.tex', 'styles/macros.sty', 'refs/library.bib'];

  it('resolves the forms TeX prints', () => {
    const r = new PathResolver(known);
    expect(r.resolve('./chapters/intro.tex')).toBe('chapters/intro.tex');
    expect(r.resolve('chapters/intro')).toBe('chapters/intro.tex');
    expect(r.resolve('/work/main.tex')).toBe('main.tex');
    expect(r.resolve('"styles/macros.sty"')).toBe('styles/macros.sty');
    expect(r.resolve('intro.tex')).toBe('chapters/intro.tex');
    expect(r.resolve('/usr/share/texlive/article.cls')).toBeNull();
  });

  it('prefixes the working directory when the engine ran in a subfolder', () => {
    const r = new PathResolver(['thesis/main.tex', 'thesis/ch/a.tex'], 'thesis');
    expect(r.resolve('./main.tex')).toBe('thesis/main.tex');
    expect(r.resolve('ch/a.tex')).toBe('thesis/ch/a.tex');
  });
});

describe('parseLog: errors', () => {
  it('reads the -file-line-error form', () => {
    const log = [
      'This is pdfTeX, Version 3.141592653',
      './chapters/intro.tex:4: Undefined control sequence.',
      'l.4 This line has an \\undefinedcommandxyz',
      '                                         in it.',
      '!  ==> Fatal error occurred, no output PDF file produced!',
    ].join('\n');
    const result = parseLog(log, { knownPaths: ['chapters/intro.tex'] });
    expect(result.hasErrors).toBe(true);
    expect(result.diagnostics[0]).toMatchObject({
      severity: 'error',
      file: 'chapters/intro.tex',
      line: 4,
      message: 'Undefined control sequence.',
    });
  });

  it('recovers the file from the parenthesis stack when there is no file-line-error', () => {
    const log = [
      '(./main.tex',
      'LaTeX2e <2024-06-01>',
      '(/usr/share/texlive/texmf-dist/tex/latex/base/article.cls',
      'Document Class: article)',
      '(./chapters/intro.tex',
      '! Undefined control sequence.',
      'l.3 Third line has \\alsoundefinedxyz',
      '                                     here.',
      ')',
      '! Missing $ inserted.',
      'l.9 x^2',
      ')',
    ].join('\n');
    const result = parseLog(log, { knownPaths: ['main.tex', 'chapters/intro.tex'] });
    expect(result.errorCount).toBe(2);
    expect(result.diagnostics[0]).toMatchObject({ file: 'chapters/intro.tex', line: 3 });
    expect(result.diagnostics[0]!.message).toContain('Undefined control sequence');
    // TeX prints the source up to the point where it stopped.
    expect(result.diagnostics[0]!.context).toBe('Third line has \\alsoundefinedxyz');
    // After the ")" the stack is back at main.tex.
    expect(result.diagnostics[1]).toMatchObject({ file: 'main.tex', line: 9 });
  });

  it('reports a missing package and the files TeX could not find', () => {
    const log = [
      '(./main.tex',
      '! LaTeX Error: File `thispackagedoesnotexistxyz.sty\' not found.',
      '',
      'Type X to quit or <RETURN> to proceed,',
      'l.2 \\usepackage{thispackagedoesnotexistxyz}',
      'No pages of output.',
    ].join('\n');
    const result = parseLog(log, { knownPaths: ['main.tex'] });
    expect(result.missingFiles).toEqual(['thispackagedoesnotexistxyz.sty']);
    expect(result.diagnostics[0]).toMatchObject({ severity: 'error', line: 2, file: 'main.tex' });
    expect(result.pages).toBe(0);
  });

  it('does not lose the file stack when a close paren shares a line', () => {
    const log = [
      '(./main.tex (./a.tex) (./b.tex',
      '! Undefined control sequence.',
      'l.7 \\boom',
      ')',
      ')',
    ].join('\n');
    const result = parseLog(log, { knownPaths: ['main.tex', 'a.tex', 'b.tex'] });
    expect(result.diagnostics[0]).toMatchObject({ file: 'b.tex', line: 7 });
  });
});

describe('parseLog: what is not a problem of its own', () => {
  it('does not count the closing line of a failed run as a second error', () => {
    const log = [
      '(/main.tex',
      '/main.tex:1: Undefined control sequence.',
      'l.1 \\undefinedcommandhere',
      '',
      '/main.tex:1:  ==> Fatal error occurred, no output PDF file produced!',
    ].join('\n');
    const summary = parseLog(log, { knownPaths: ['main.tex'] });
    expect(summary.errorCount).toBe(1);
    expect(summary.diagnostics[0]).toMatchObject({ severity: 'error', file: 'main.tex', line: 1, message: 'Undefined control sequence.' });
  });

  it('keeps that closing line when it is the only thing the log says', () => {
    const summary = parseLog('!  ==> Fatal error occurred, no output PDF file produced!\n');
    expect(summary.errorCount).toBe(1);
  });

  it('files a warning nobody can act on in a browser as a note', () => {
    const summary = parseLog('(/main.tex\nPackage epstopdf Warning: Shell escape feature is not enabled.\n)');
    expect(summary.warningCount).toBe(0);
    expect(summary.diagnostics[0]?.severity).toBe('info');
  });
});

describe('parseLog: warnings and info', () => {
  it('extracts references, citations and the input line', () => {
    const log = [
      '(./main.tex',
      'LaTeX Warning: Reference `fig:plot\' on page 1 undefined on input line 12.',
      '',
      'LaTeX Warning: Citation `knuth1984\' on page 2 undefined on input line 20.',
      '',
      'Package hyperref Warning: Token not allowed in a PDF string (Unicode):',
      '  removing `\\textbf\' on input line 30.',
      '',
      'LaTeX Warning: There were undefined references.',
      '',
      'Output written on main.pdf (3 pages, 12345 bytes).',
    ].join('\n');
    const result = parseLog(log, { knownPaths: ['main.tex'] });
    expect(result.pages).toBe(3);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(4);
    expect(result.diagnostics[0]).toMatchObject({ severity: 'warning', line: 12, file: 'main.tex' });
    expect(result.diagnostics[1]!.message).toContain('Citation');
    expect(result.diagnostics[2]!.message).toContain('Package hyperref');
    expect(result.diagnostics[2]!.message).toContain('removing');
    expect(result.diagnostics[2]!.line).toBe(30);
  });

  it('joins the lines a package continues its message on', () => {
    const log = [
      '(./main.tex',
      'Package biblatex Warning: Using fall-back bibtex backend:',
      '(biblatex)                functionality may be reduced/unavailable.',
      '',
      'Package hyperref Warning: Token not allowed in a PDF string (Unicode):',
      "(hyperref)                removing `math shift' on input line 14.",
      '',
      ')',
    ].join('\n');
    const { diagnostics } = parseLog(log, { knownPaths: ['main.tex'] });
    expect(diagnostics.map((d) => d.message)).toEqual([
      'Package biblatex: Using fall-back bibtex backend: functionality may be reduced/unavailable.',
      "Package hyperref: Token not allowed in a PDF string (Unicode): removing `math shift' on input line 14.",
    ]);
    expect(diagnostics[1]).toMatchObject({ file: 'main.tex', line: 14 });
  });

  it('does not take a line number inside a package for a line of the project', () => {
    const log = [
      '(./main.tex',
      '(/texlive/texmf-dist/tex/generic/babel-french/french.ldf',
      "Package babel Warning: No hyphenation patterns were preloaded for the language 'French' on input line 87.",
      '',
      '/texlive/texmf-dist/tex/generic/babel-french/french.ldf:120: Undefined control sequence.',
      ')',
      "LaTeX Warning: Reference `fig:x' on page 1 undefined on input line 9.",
      ')',
    ].join('\n');
    const { diagnostics } = parseLog(log, { knownPaths: ['main.tex'], wrapWidth: 0 });
    expect(diagnostics.map((d) => [d.file, d.line])).toEqual([
      ['main.tex', null],
      ['main.tex', null],
      ['main.tex', 9],
    ]);
  });

  it('keeps bad boxes out unless asked for', () => {
    const log = [
      '(./main.tex',
      'Overfull \\hbox (12.34pt too wide) in paragraph at lines 10--12',
      'Underfull \\vbox (badness 10000) detected at line 40',
    ].join('\n');
    expect(parseLog(log).diagnostics).toHaveLength(0);
    const withBoxes = parseLog(log, { includeBadBoxes: true, knownPaths: ['main.tex'] });
    expect(withBoxes.diagnostics).toHaveLength(2);
    expect(withBoxes.diagnostics[0]).toMatchObject({ severity: 'info', line: 10, file: 'main.tex' });
    expect(withBoxes.diagnostics[1]!.message).toContain('Underfull \\vbox');
  });

  it('handles an empty or truncated log without throwing', () => {
    expect(parseLog('')).toMatchObject({ diagnostics: [], hasErrors: false, pages: null });
    expect(parseLog('! Emergency stop.').diagnostics[0]).toMatchObject({ severity: 'error', file: null, line: null });
  });

  it('parses a wrapped log, which is what engines produce by default', () => {
    const message = 'LaTeX Warning: Reference `a-very-long-label-name-that-pushes-past-the-print-width\' on page 1 undefined on input line 42.';
    const wrapped: string[] = [];
    for (let i = 0; i < message.length; i += 79) wrapped.push(message.slice(i, i + 79));
    const result = parseLog(['(./main.tex', ...wrapped, ''].join('\n'), { knownPaths: ['main.tex'] });
    expect(result.warningCount).toBe(1);
    expect(result.diagnostics[0]!.line).toBe(42);
  });
});

describe('explain', () => {
  it('turns TeX jargon into a headline and a hint', () => {
    const cases: [string, string][] = [
      ['Undefined control sequence.', 'Unknown command'],
      ["LaTeX Error: File `tikz.sty' not found.", 'Missing file: tikz.sty'],
      ['Missing $ inserted.', 'Math outside math mode'],
      ["LaTeX Warning: Reference `fig:plot' on page 1 undefined on input line 12.", 'Reference not found: fig:plot'],
      ["LaTeX Warning: Citation `knuth1984' undefined", 'Citation not found: knuth1984'],
      ['Runaway argument?', 'Something was never closed'],
      ["LaTeX Error: Environment align* undefined.", 'Unknown environment: align*'],
      ['Emergency stop.', 'TeX gave up'],
    ];
    for (const [message, headline] of cases) {
      const explained = explain({ severity: 'error', message, file: null, line: null, context: null, raw: message });
      expect(explained?.headline, message).toBe(headline);
      expect(explained?.hint.length).toBeGreaterThan(10);
    }
  });

  it('returns null for messages it does not know', () => {
    expect(
      explain({ severity: 'error', message: 'Something very unusual', file: null, line: null, context: null, raw: '' }),
    ).toBeNull();
  });
});
