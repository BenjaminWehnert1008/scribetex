import { describe, expect, it } from 'vitest';
import {
  cleanTitle,
  detectBibTool,
  detectMainFile,
  isBuildArtifact,
  isRootDocument,
  needsMakeIndex,
  outputPdfPath,
  parseGraphicsPaths,
  scanBibKeys,
  scanDependencies,
  scanLabels,
  scanOutline,
  stripComments,
} from './deps';

describe('stripComments', () => {
  it('removes comments but keeps escaped percent signs', () => {
    expect(stripComments('a % comment\nb 50\\% done % more\n').trim()).toBe('a \nb 50\\% done');
  });

  it('keeps verbatim content intact', () => {
    const source = '\\begin{lstlisting}\nx = 1 % not a comment\n\\end{lstlisting}\nreal % gone\n';
    const out = stripComments(source);
    expect(out).toContain('x = 1 % not a comment');
    expect(out).not.toContain('% gone');
  });
});

describe('isRootDocument', () => {
  it('needs both a document class and a document body', () => {
    expect(isRootDocument('\\documentclass{article}\n\\begin{document}\nx\n\\end{document}')).toBe(true);
    expect(isRootDocument('\\documentclass[11pt]{report}\n\\begin{document}\\end{document}')).toBe(true);
    expect(isRootDocument('\\chapter{Intro}\nText')).toBe(false);
    expect(isRootDocument('% \\documentclass{article}\n% \\begin{document}')).toBe(false);
  });
});

describe('scanDependencies', () => {
  const files = [
    'main.tex',
    'chapters/intro.tex',
    'chapters/methods/setup.tex',
    'styles/macros.sty',
    'refs/library.bib',
    'figures/plot.png',
    'figures/vector/diagram.pdf',
  ];

  it('resolves includes, packages, bibliographies and figures', () => {
    const source = [
      '\\documentclass{report}',
      '\\usepackage{graphicx,styles/macros}',
      '\\graphicspath{{figures/}{figures/vector/}}',
      '\\begin{document}',
      '\\include{chapters/intro}',
      '\\input{chapters/methods/setup.tex}',
      '\\includegraphics[width=0.5\\textwidth]{plot.png}',
      '\\includegraphics{diagram.pdf}',
      '\\bibliography{refs/library}',
      '\\end{document}',
    ].join('\n');
    const refs = scanDependencies(source, { from: 'main.tex', files });
    const resolved = refs.filter((r) => r.resolved).map((r) => r.resolved);
    expect(resolved).toEqual([
      'styles/macros.sty',
      'chapters/intro.tex',
      'chapters/methods/setup.tex',
      'figures/plot.png',
      'figures/vector/diagram.pdf',
      'refs/library.bib',
    ]);
    // graphicx is a TeX Live package, not a project file.
    expect(refs.find((r) => r.raw === 'graphicx')!.resolved).toBeNull();
  });

  it('resolves relative to the including file', () => {
    const refs = scanDependencies('\\input{methods/setup}', { from: 'chapters/intro.tex', files });
    expect(refs[0]!.resolved).toBe('chapters/methods/setup.tex');
  });

  it('reports an unresolved figure so the UI can warn about it', () => {
    const refs = scanDependencies('\\includegraphics{missing.png}', { from: 'main.tex', files });
    expect(refs).toEqual([{ command: 'includegraphics', raw: 'missing.png', resolved: null, line: 1 }]);
  });

  it('ignores commented-out and macro-built arguments', () => {
    const refs = scanDependencies('% \\input{chapters/intro}\n\\input{\\chapterdir/x}', { from: 'main.tex', files });
    expect(refs).toEqual([]);
  });

  it('reads graphicspath', () => {
    expect(parseGraphicsPaths('\\graphicspath{{figures/}{./img/}}')).toEqual(['figures', 'img']);
    expect(parseGraphicsPaths('no paths here')).toEqual([]);
  });
});

describe('detectMainFile', () => {
  it('prefers the root that nothing includes', () => {
    const sources = new Map([
      ['main.tex', '\\documentclass{report}\n\\begin{document}\\include{chapters/intro}\\end{document}'],
      ['chapters/intro.tex', '\\chapter{Intro}'],
      // A standalone sub-document, as the subfiles package uses.
      ['chapters/standalone.tex', '\\documentclass{article}\n\\begin{document}x\\end{document}'],
    ]);
    expect(detectMainFile(sources)).toBe('main.tex');
  });

  it('prefers a shallow file named main when several roots are unused', () => {
    const sources = new Map([
      ['deep/folder/paper.tex', '\\documentclass{article}\\begin{document}\\end{document}'],
      ['main.tex', '\\documentclass{article}\\begin{document}\\end{document}'],
    ]);
    expect(detectMainFile(sources)).toBe('main.tex');
  });

  it('returns null when there is no document at all', () => {
    expect(detectMainFile(new Map([['notes.tex', '\\chapter{x}']]))).toBeNull();
    expect(detectMainFile(new Map())).toBeNull();
  });

  it('picks the included root when the other document is itself included', () => {
    const sources = new Map([
      ['thesis.tex', '\\documentclass{report}\n\\begin{document}\\input{parts/body}\\end{document}'],
      ['parts/body.tex', '\\chapter{Body}'],
    ]);
    expect(detectMainFile(sources)).toBe('thesis.tex');
  });
});

describe('outline and completions', () => {
  it('reads headings with levels', () => {
    const source = [
      '\\chapter{First chapter}',
      '\\section[short]{A \\textbf{bold} section}',
      '\\subsection*{Unnumbered}',
      '\\part{Zero}',
    ].join('\n');
    expect(scanOutline(source, 'main.tex')).toEqual([
      { level: 1, kind: 'chapter', title: 'First chapter', line: 1, file: 'main.tex', starred: false },
      { level: 2, kind: 'section', title: 'A bold section', line: 2, file: 'main.tex', starred: false },
      { level: 3, kind: 'subsection', title: 'Unnumbered', line: 3, file: 'main.tex', starred: true },
      { level: 0, kind: 'part', title: 'Zero', line: 4, file: 'main.tex', starred: false },
    ]);
  });

  it('cleans titles for display', () => {
    expect(cleanTitle('\\textbf{Big}~title \\emph{here}')).toBe('Big title here');
  });

  it('finds labels and bib keys', () => {
    expect(scanLabels('\\section{A}\\label{sec:a}\ntext\n\\label{fig:b}')).toEqual([
      { name: 'sec:a', line: 1 },
      { name: 'fig:b', line: 3 },
    ]);
    const bib = [
      '@book{knuth1984,',
      '  author = {Donald E. Knuth},',
      '  title = {The {\\TeX}book},',
      '}',
      '@article{lamport1994, title = "LaTeX" }',
    ].join('\n');
    expect(scanBibKeys(bib)).toEqual([
      { key: 'knuth1984', title: 'The \\TeXbook', line: 1 },
      { key: 'lamport1994', title: null, line: 5 },
    ]);
  });
});

describe('build decisions', () => {
  it('detects which bibliography tool is needed', () => {
    expect(detectBibTool('\\usepackage[backend=biber]{biblatex}')).toBe('biber');
    expect(detectBibTool('\\usepackage{biblatex}')).toBe('biber');
    expect(detectBibTool('\\usepackage[backend=bibtex,style=numeric]{biblatex}')).toBe('bibtex');
    expect(detectBibTool('\\bibliography{refs}')).toBe('bibtex');
    expect(detectBibTool('\\begin{thebibliography}{9}')).toBeNull();
    expect(detectBibTool('% \\bibliography{refs}')).toBeNull();
  });

  it('detects makeindex', () => {
    expect(needsMakeIndex('\\makeindex\n\\printindex')).toBe(true);
    expect(needsMakeIndex('\\makeindex')).toBe(false);
  });

  it('knows build artifacts from sources', () => {
    for (const path of ['main.aux', 'main.log', 'a/main.bbl', 'main.synctex.gz', 'main.run.xml', 'main.fdb_latexmk']) {
      expect(isBuildArtifact(path), path).toBe(true);
    }
    for (const path of ['main.tex', 'refs.bib', 'figures/plot.png', 'styles/macros.sty']) {
      expect(isBuildArtifact(path), path).toBe(false);
    }
  });

  it('derives the output pdf path', () => {
    expect(outputPdfPath('main.tex')).toBe('main.pdf');
    expect(outputPdfPath('thesis/main.tex')).toBe('thesis/main.pdf');
  });
});
