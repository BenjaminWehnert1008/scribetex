import { strFromU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { convertDocx, DocxError, type ConvertedProject } from './convert';
import { ommlToLatex } from './omml';
import {
  BASIC_NUMBERING,
  buildDocx,
  cell,
  field,
  heading,
  listItem,
  para,
  picture,
  QUADRATIC_FORMULA,
  run,
  sampleThesis,
  table,
  tableRow,
  TINY_PNG,
} from './test-docx';
import { parseXml } from './xml';

function file(result: ConvertedProject, path: string): string {
  const found = result.files.find((item) => item.path === path);
  if (!found) throw new Error(`${path} is missing; files: ${result.files.map((item) => item.path).join(', ')}`);
  return strFromU8(found.bytes);
}

/** All LaTeX of the project, main.tex first. */
function allTex(result: ConvertedProject): string {
  return result.files
    .filter((item) => item.path.endsWith('.tex'))
    .map((item) => strFromU8(item.bytes))
    .join('\n');
}

const convert = (body: string, extra: Parameters<typeof buildDocx>[0] extends infer P ? Omit<P, 'body'> : never = {}) =>
  convertDocx(buildDocx({ body, ...extra }), { fileName: 'test.docx' });

describe('convertDocx', () => {
  it('turns a thesis into main.tex, one file per section, pictures and references', async () => {
    const result = await convertDocx(sampleThesis(), { fileName: 'My thesis.docx' });
    const paths = result.files.map((item) => item.path);
    expect(paths).toEqual([
      'main.tex',
      'sections/01-introduction.tex',
      'sections/02-methods.tex',
      'sections/03-conclusion.tex',
      'images/figure-01-a-picture-of-the-setup.png',
      'references.bib',
    ]);
    expect(result.dirs.sort()).toEqual(['images', 'sections']);
    expect(result.name).toBe('Moving from Word to LaTeX');
    expect(result.mainFile).toBe('main.tex');

    const main = file(result, 'main.tex');
    expect(main).toContain('\\documentclass[11pt,a4paper]{article}');
    expect(main).toContain('\\title{Moving from Word to LaTeX\\\\[1ex]\\large A sample thesis}');
    expect(main).toContain('\\author{Ada Lovelace}');
    expect(main).toContain('\\maketitle');
    expect(main).toContain('\\input{sections/01-introduction}\n\n\\input{sections/02-methods}\n\n\\input{sections/03-conclusion}');
    // The "References" heading becomes the bibliography's own title.
    expect(main).toContain('\\renewcommand{\\refname}{References}');
    expect(main).toMatch(/\\bibliographystyle\{plain\}\n\\bibliography\{references\}\n+\\end\{document\}/);

    const intro = file(result, 'sections/01-introduction.tex');
    expect(intro).toContain('\\section{Introduction}');
    expect(intro).toContain('This text has \\textbf{bold}, \\emph{italic} and special characters: 50\\% \\& \\$5 \\#1 a\\_b \\{x\\} \\textasciitilde{} \\textasciicircum{} ``quotes\'\' -- \\texteuro{}.');
    expect(intro).toContain('\\footnote{A footnote with \\emph{emphasis}.}');
    expect(intro).toContain('As \\cite{lam94} explains, see Figure~\\ref{fig:a-picture-of-the-setup}.');
    expect(intro).toContain('\\subsection{Lists}');
    expect(intro).toContain('\\begin{itemize}\n  \\item First point\n  \\item Second point\n  \\begin{itemize}\n    \\item A detail\n  \\end{itemize}\n\\end{itemize}');
    expect(intro).toContain('\\begin{enumerate}\n  \\item Step one\n  \\item Step two\n\\end{enumerate}');

    const methods = file(result, 'sections/02-methods.tex');
    expect(methods).toContain('\\[\n  x=\\frac{-b\\pm\\sqrt{b^{2}-4ac}}{2a}\n\\]');
    expect(methods).toContain(
      '\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=0.50\\linewidth]{images/figure-01-a-picture-of-the-setup.png}\n  \\caption{A picture of the setup}\\label{fig:a-picture-of-the-setup}\n\\end{figure}',
    );
    expect(methods).toContain('\\caption{Measured values}\n\\begin{tabular}{L{0.331}L{0.331}L{0.331}}');
    expect(methods).toContain('Sample & Value & Note \\\\\n\\midrule');
    expect(methods).toContain('\\multirow{2}{=}{A} & 1.5 & first \\\\\n & 2.0 & second \\\\');
    expect(methods).toContain('B & \\multicolumn{2}{L{0.661}}{both columns} \\\\');

    expect(file(result, 'references.bib')).toContain(
      '@book{lam94,\n  author    = {Lamport, Leslie},\n  title     = {{LaTeX: A Document Preparation System}},\n  year      = {1994},\n  publisher = {Addison-Wesley}\n}',
    );
    expect(result.summary).toMatchObject({ documentClass: 'article', parts: 3, images: 1, tables: 1, equations: 1, footnotes: 1, references: 1, citations: 1 });
    expect(result.warnings).toEqual([]);
  });

  it('uses the report class with chapters for long documents with a table of contents', async () => {
    const body = [
      para(field('TOC \\o "1-3" \\h \\z \\u', 'Introduction 1')),
      heading(1, 'Introduction'),
      para(run('Text.')),
      heading(2, 'Background'),
      heading(1, 'Results'),
      para(run('More text.')),
    ].join('');
    const result = await convert(body);
    const main = file(result, 'main.tex');
    expect(main).toContain('{report}');
    expect(main).toContain('\\input{chapters/00-front-matter}\n\n\\include{chapters/01-introduction}\n\n\\include{chapters/02-results}');
    expect(file(result, 'chapters/00-front-matter.tex')).toBe('\\tableofcontents\n');
    expect(file(result, 'chapters/01-introduction.tex')).toBe('\\chapter{Introduction}\n\nText.\n\n\\section{Background}\n');
  });

  it('keeps a short document in main.tex and leaves out \\maketitle without a title', async () => {
    const result = await convert(para(run('Just one paragraph.')), { title: 'From the properties' });
    expect(result.files.map((item) => item.path)).toEqual(['main.tex']);
    const main = file(result, 'main.tex');
    expect(main).toContain('\\title{From the properties}');
    expect(main).not.toContain('\\maketitle');
    expect(main).toContain('\\begin{document}\nJust one paragraph.\n\n\\end{document}');
    expect(result.name).toBe('From the properties');
  });

  it('names the project after the file when the document has no title', async () => {
    const result = await convertDocx(buildDocx({ body: para(run('x')) }), { fileName: 'Bachelorarbeit final v3.docx' });
    expect(result.name).toBe('Bachelorarbeit final v3');
  });

  it('removes numbers typed into headings, and does not number front matter', async () => {
    const body = [heading(1, 'Abstract'), para(run('Short.')), heading(1, '1. Introduction'), heading(2, '1.2 Scope'), heading(1, 'Chapter 2: Theory')].join('');
    const text = allTex(await convert(body));
    expect(text).toContain('\\section*{Abstract}\n\\addcontentsline{toc}{section}{Abstract}');
    expect(text).toContain('\\section{Introduction}');
    expect(text).toContain('\\subsection{Scope}');
    expect(text).toContain('\\section{Theory}');
  });

  it('nests lists and keeps their numbering style and count', async () => {
    const body = [
      listItem('one', 2),
      listItem('sub a', 2, 1),
      listItem('sub b', 2, 1),
      listItem('two', 2),
      para(run('An interruption.')),
      listItem('three', 2),
    ].join('');
    const text = allTex(await convert(body, { numbering: BASIC_NUMBERING }));
    expect(text).toContain('\\usepackage{enumitem}');
    expect(text).toContain(
      '\\begin{enumerate}\n  \\item one\n  \\begin{enumerate}[label=\\alph*)]\n    \\item sub a\n    \\item sub b\n  \\end{enumerate}\n  \\item two\n\\end{enumerate}\n\nAn interruption.\n\n\\begin{enumerate}[start=3]\n  \\item three\n\\end{enumerate}',
    );
  });

  it('writes footnotes inside tables after the table', async () => {
    const body = table([4000, 4000], [tableRow([cell(para(run('a') + '<w:r><w:footnoteReference w:id="1"/></w:r>')), cell(para(run('b')))])]);
    const text = allTex(await convert(body, { footnotes: `<w:footnote w:id="1"><w:p>${run('Note.')}</w:p></w:footnote>` }));
    expect(text).toContain('a\\footnotemark{} & b \\\\');
    expect(text).toContain('\\end{center}\n\\addtocounter{footnote}{-1}\n\\stepcounter{footnote}\\footnotetext{Note.}');
  });

  it('uses longtable for long tables', async () => {
    const rows = Array.from({ length: 30 }, (_, k) => tableRow([cell(para(run(`row ${k}`))), cell(para(run('x')))]));
    const text = allTex(await convert(table([4000, 4000], rows)));
    expect(text).toContain('\\usepackage{longtable}');
    expect(text).toContain('\\begin{longtable}{L{0.441}L{0.441}}\n\\toprule\nrow 0 & x \\\\\n\\midrule\n\\endfirsthead');
  });

  it('turns hyperlinks into \\href and internal links into \\hyperref', async () => {
    const body = [
      heading(1, 'Target section', 'target'),
      para(`<w:hyperlink r:id="link1"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>the site</w:t></w:r></w:hyperlink>`),
      para(`<w:hyperlink r:id="link2">${run('https://example.org/a_b')}</w:hyperlink>`),
      para(`<w:hyperlink w:anchor="target">${run('back up')}</w:hyperlink>`),
      para(field('HYPERLINK "https://example.org/?q=1%"', 'a field link')),
    ].join('');
    const rels =
      '<Relationship Id="link1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.org/#top" TargetMode="External"/>' +
      '<Relationship Id="link2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.org/a_b" TargetMode="External"/>';
    const text = allTex(await convert(body, { rels }));
    expect(text).toContain('\\href{https://example.org/\\#top}{the site}');
    expect(text).not.toContain('\\uline');
    expect(text).toContain('\\url{https://example.org/a_b}');
    expect(text).toContain('\\section{Target section}\\label{sec:target-section}');
    expect(text).toContain('\\hyperref[sec:target-section]{back up}');
    expect(text).toContain('\\href{https://example.org/?q=1\\%}{a field link}');
  });

  it('keeps inserted text and drops deleted text', async () => {
    const body = para(`${run('Kept ')}<w:ins w:id="1" w:author="A">${run('inserted ')}</w:ins><w:del w:id="2" w:author="A"><w:r><w:delText>deleted </w:delText></w:r></w:del>${run('end.')}`);
    expect(allTex(await convert(body))).toContain('Kept inserted end.');
  });

  it('reads Zotero citations and their page numbers', async () => {
    const zotero = (id: string, family: string, year: string, locator = '') =>
      `ADDIN ZOTERO_ITEM CSL_CITATION {"citationID":"x","citationItems":[{"id":"${id}","uris":["http://zotero.org/users/1/items/${id}"],${locator ? `"locator":"${locator}","label":"page",` : ''}"itemData":{"id":"${id}","type":"article-journal","title":"On ${family}","container-title":"Journal","author":[{"family":"${family}","given":"A."}],"issued":{"date-parts":[["${year}"]]}}}]}`;
    const body = [
      para(run('First ') + field(zotero('A1', 'Curie', '1903'), '(Curie, 1903)') + run(' and again ') + field(zotero('A1', 'Curie', '1903', '12-14'), '(Curie, 1903, p. 12)')),
      para(field('ADDIN ZOTERO_BIBL {"uncited":[]} CSL_BIBLIOGRAPHY', 'Curie, A. (1903). On Curie.')),
    ].join('');
    const result = await convert(body);
    const text = allTex(result);
    expect(text).toContain('First \\cite{curie1903} and again \\cite[pp.~12-14]{curie1903}');
    expect(text).toContain('\\bibliography{references}');
    expect(file(result, 'references.bib')).toContain('@article{curie1903,\n  author  = {Curie, A.},\n  title   = {{On Curie}},\n  journal = {Journal},\n  year    = {1903}\n}');
  });

  it('marks characters pdfLaTeX cannot print, and says so', async () => {
    const result = await convert(para(run('Price: 5\u20AC, \u2248 3 \u2192 4, \u03B1-test, \u4E2D\u6587')));
    expect(allTex(result)).toContain('Price: 5\\texteuro{}, $\\approx$ 3 $\\rightarrow$ 4, $\\alpha$-test, \\textbf{?}\\textbf{?}');
    expect(result.warnings.join(' ')).toContain('2 characters that pdfLaTeX cannot print');
  });

  it('loads babel for the document language', async () => {
    expect(file(await convert(para(run('Hallo')), { lang: 'de-DE' }), 'main.tex')).toContain('\\usepackage[ngerman]{babel}');
    expect(file(await convert(para(run('Hello')), { lang: 'en-GB' }), 'main.tex')).not.toContain('babel');
  });

  it('keeps pictures in formats pdfLaTeX cannot show, marked in the text', async () => {
    const result = await convert(para(picture('old', 5, 5)), { media: { 'old.emf': new Uint8Array([1, 2, 3]) } });
    expect(result.files.map((item) => item.path)).toContain('images/old.emf');
    expect(allTex(result)).toContain('Picture \\texttt{images/old.emf} is in a format pdfLaTeX cannot show.');
    expect(result.warnings.join(' ')).toContain('format pdfLaTeX cannot show');
  });

  it('converts pictures to PNG when it can', async () => {
    const toPng = async () => TINY_PNG;
    const result = await convertDocx(buildDocx({ body: para(picture('anim', 5, 5)), media: { 'anim.gif': new Uint8Array([71, 73, 70]) } }), { toPng });
    expect(result.files.map((item) => item.path)).toContain('images/anim.png');
    expect(allTex(result)).toContain('\\includegraphics[width=0.31\\linewidth]{images/anim.png}');
  });

  it('leaves out pictures that the text does not use', async () => {
    const result = await convert(para(run('No pictures here.')), { media: { 'logo.png': TINY_PNG } });
    expect(result.files.map((item) => item.path)).toEqual(['main.tex']);
  });

  it('turns code paragraphs into verbatim and quotes into quote', async () => {
    const styles =
      '<w:style w:type="paragraph" w:styleId="SourceCode"><w:name w:val="Source Code"/></w:style>';
    const body = [para(run('int main() {'), 'SourceCode'), para(run('  return 0; }'), 'SourceCode'), para(run('Wise words.'), 'Quote')].join('');
    const text = allTex(await convert(body, { styles }));
    expect(text).toContain('\\begin{verbatim}\nint main() {\n  return 0; }\n\\end{verbatim}');
    expect(text).toContain('\\begin{quote}\nWise words.\n\\end{quote}');
  });

  it('reads documents whose XML uses other namespace prefixes', async () => {
    const plain = buildDocx({ body: heading(1, 'Hello') + para(run('World')) });
    const unzipped = (await import('fflate')).unzipSync(plain);
    const xml = strFromU8(unzipped['word/document.xml']!).replace(/xmlns:w=/, 'xmlns:ns0=').replace(/<(\/?)w:/g, '<$1ns0:').replace(/ w:/g, ' ns0:');
    unzipped['word/document.xml'] = new TextEncoder().encode(xml);
    const text = allTex(await convertDocx(zipSync(unzipped)));
    expect(text).toContain('\\section{Hello}');
    expect(text).toContain('World');
  });

  it('explains what to do with files it cannot read', async () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    await expect(convertDocx(ole, { fileName: 'old.doc' })).rejects.toThrow(/older Word file \(\.doc\)/);
    await expect(convertDocx(ole, { fileName: 'secret.docx' })).rejects.toThrow(/password protected/);
    await expect(convertDocx(new TextEncoder().encode('hello'), { fileName: 'notes.docx' })).rejects.toBeInstanceOf(DocxError);
    await expect(convertDocx(zipSync({ 'a.txt': new Uint8Array([1]) }))).rejects.toThrow(/no Word document inside/);
  });

  it('numbers equations that Word numbered', async () => {
    const m = (inner: string) => `<m:oMathPara><m:oMath>${inner}</m:oMath></m:oMathPara>`;
    const mr = (text: string) => `<m:r><m:t>${text}</m:t></m:r>`;
    const body = [
      // Word 365: the number is part of the equation, after a #.
      para(m(`<m:eqArr><m:e>${mr('E=m')}<m:sSup><m:e>${mr('c')}</m:e><m:sup>${mr('2')}</m:sup></m:sSup>${mr('#')}<m:d><m:e>${mr('1')}</m:e></m:d></m:e></m:eqArr>`)),
      // Older documents: the number typed after the equation, behind a tab.
      para(`${m(mr('a+b=c'))}<w:r><w:tab/></w:r>${run('(2)')}`),
      para(m(mr('x=1'))),
    ].join('');
    const text = allTex(await convert(body));
    expect(text).toContain('\\begin{equation}\n  E=mc^{2}\n\\end{equation}');
    expect(text).toContain('\\begin{equation}\n  a+b=c\n\\end{equation}');
    expect(text).not.toContain('(2)');
    expect(text).toContain('\\[\n  x=1\n\\]');
  });

  it('leaves out the placeholder text of empty content controls', async () => {
    const body =
      `<w:sdt><w:sdtPr><w:showingPlcHdr/></w:sdtPr><w:sdtContent>${para(run('Click or tap here to enter text.'))}</w:sdtContent></w:sdt>` +
      `<w:sdt><w:sdtPr/><w:sdtContent>${para(run('Filled in.'))}</w:sdtContent></w:sdt>`;
    const text = allTex(await convert(body));
    expect(text).not.toContain('Click or tap');
    expect(text).toContain('Filled in.');
  });

  it('only refers to files that it writes', async () => {
    const result = await convertDocx(sampleThesis());
    const paths = new Set(result.files.map((item) => item.path));
    const text = allTex(result);
    for (const match of text.matchAll(/\\(?:input|include)\{([^}]+)\}/g)) expect(paths.has(`${match[1]}.tex`), match[1]).toBe(true);
    for (const match of text.matchAll(/\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g)) expect(paths.has(match[1]!), match[1]).toBe(true);
    const bib = file(result, 'references.bib');
    for (const match of text.matchAll(/\\cite(?:\[[^\]]*\])?\{([^}]+)\}/g)) for (const key of match[1]!.split(',')) expect(bib).toContain(`{${key},`);
    // No placeholders are left over.
    expect(text).not.toContain('\u0001');
  });
});

describe('ommlToLatex', () => {
  const math = (inner: string) => ommlToLatex(parseXml(`<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">${inner}</m:oMath>`));
  const r = (text: string) => `<m:r><m:t>${text}</m:t></m:r>`;

  it('writes fractions, roots, scripts and Greek letters', () => {
    expect(ommlToLatex(parseXml(QUADRATIC_FORMULA))).toBe('x=\\frac{-b\\pm\\sqrt{b^{2}-4ac}}{2a}');
    expect(math(`<m:sSubSup><m:e>${r('x')}</m:e><m:sub>${r('i')}</m:sub><m:sup>${r('2')}</m:sup></m:sSubSup>`)).toBe('x_{i}^{2}');
    expect(math(r('α+β≤γ'))).toBe('\\alpha+\\beta\\leq\\gamma');
    expect(math(`<m:rad><m:deg>${r('3')}</m:deg><m:e>${r('x')}</m:e></m:rad>`)).toBe('\\sqrt[3]{x}');
  });

  it('writes sums, integrals and limits', () => {
    expect(math(`<m:nary><m:naryPr><m:chr m:val="∑"/><m:limLoc m:val="undOvr"/></m:naryPr><m:sub>${r('i=1')}</m:sub><m:sup>${r('n')}</m:sup><m:e>${r('i')}</m:e></m:nary>`)).toBe('\\sum_{i=1}^{n} i');
    expect(math(`<m:nary><m:sub>${r('0')}</m:sub><m:sup>${r('∞')}</m:sup><m:e>${r('f')}</m:e></m:nary>`)).toBe('\\int_{0}^{\\infty} f');
    expect(
      math(`<m:func><m:fName><m:limLow><m:e><m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>lim</m:t></m:r></m:e><m:lim>${r('n→∞')}</m:lim></m:limLow></m:fName><m:e>${r('a')}</m:e></m:func>`),
    ).toBe('\\lim_{n\\rightarrow\\infty}{a}');
    expect(math(`<m:func><m:fName><m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>sin</m:t></m:r></m:fName><m:e>${r('x')}</m:e></m:func>`)).toBe('\\sin{x}');
  });

  it('writes brackets, matrices and accents', () => {
    expect(math(`<m:d><m:e>${r('a+b')}</m:e></m:d>`)).toBe('\\left( a+b \\right)');
    expect(math(`<m:d><m:dPr><m:begChr m:val="["/><m:endChr m:val="]"/></m:dPr><m:e><m:m><m:mr><m:e>${r('1')}</m:e><m:e>${r('0')}</m:e></m:mr><m:mr><m:e>${r('0')}</m:e><m:e>${r('1')}</m:e></m:mr></m:m></m:e></m:d>`)).toBe(
      '\\begin{bmatrix}1 & 0 \\\\ 0 & 1\\end{bmatrix}',
    );
    expect(math(`<m:acc><m:accPr><m:chr m:val="\u20D7"/></m:accPr><m:e>${r('v')}</m:e></m:acc>`)).toBe('\\vec{v}');
    expect(math(`<m:acc><m:e>${r('xy')}</m:e></m:acc>`)).toBe('\\widehat{xy}');
    expect(math(`<m:bar><m:barPr><m:pos m:val="top"/></m:barPr><m:e>${r('z')}</m:e></m:bar>`)).toBe('\\overline{z}');
  });

  it('keeps commands apart from the letters that follow them', () => {
    expect(math(r('πr'))).toBe('\\pi r');
    expect(math(r('2πr'))).toBe('2\\pi r');
  });
});
