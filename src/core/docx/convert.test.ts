import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
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

  it('keeps the words around a citation, with page labels in the document language', async () => {
    const csl = (items: string[]) => `ADDIN ZOTERO_ITEM CSL_CITATION {"citationID":"x","citationItems":[${items.join(',')}]}`;
    const item = (id: string, family: string, extra = '') =>
      `{"id":"${id}","uris":["http://zotero.org/users/1/items/${id}"],${extra}"itemData":{"id":"${id}","type":"book","title":"Über ${family}","author":[{"family":"${family}","given":"A."}],"issued":{"date-parts":[["2019"]]}}}`;
    const body = [
      para(run('Indirekt ') + field(csl([item('B1', 'Wolf', '"prefix":"vgl.","locator":"12","label":"page",')]), '(vgl. Wolf 2019, S. 12)')),
      para(run('Zwei ') + field(csl([item('B1', 'Wolf', '"locator":"3-5",'), item('B2', 'Berg', '"suffix":", mit Beispielen",')]), '(Wolf 2019, S. 3-5; Berg 2019, mit Beispielen)')),
      para(run('Beide ') + field(csl([item('B1', 'Wolf', '"prefix":"siehe",'), item('B2', 'Berg')]), '(siehe Wolf 2019; Berg 2019)')),
    ].join('');
    const text = allTex(await convert(body, { lang: 'de-DE' }));
    expect(text).toContain('Indirekt vgl.~\\cite[S.~12]{wolf2019}');
    expect(text).toContain('Zwei \\cite[S.~3-5]{wolf2019}; \\cite[mit Beispielen]{berg2019}');
    expect(text).toContain('Beide siehe~\\cite{wolf2019,berg2019}');
  });

  it('keeps the pages and words of Word citations, and lists uncited sources like Word', async () => {
    const source = (tag: string, last: string, title: string, year: string) =>
      `<b:Source><b:Tag>${tag}</b:Tag><b:SourceType>Book</b:SourceType><b:Author><b:Author><b:NameList><b:Person><b:Last>${last}</b:Last><b:First>A.</b:First></b:Person></b:NameList></b:Author></b:Author><b:Title>${title}</b:Title><b:Year>${year}</b:Year></b:Source>`;
    const sources = `<b:Sources xmlns:b="http://schemas.openxmlformats.org/officeDocument/2006/bibliography">${source('Lam94', 'Lamport', 'LaTeX', '1994')}${source('Knu84', 'Knuth', 'The TeXbook', '1984')}${source('Uncited', 'Nobody', 'Read but not cited', '2001')}</b:Sources>`;
    const body = [
      para(run('As shown ') + field('CITATION Lam94 \\p 12 \\f "see" \\l 1033 \\m Knu84 \\s "for the details"', '(see Lamport, 1994, p. 12; Knuth, 1984 for the details)') + run('.')),
      heading(1, 'References'),
      `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> BIBLIOGRAPHY </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${run('Knuth, A. (1984). The TeXbook.')}</w:p>`,
      `<w:p>${run('Nobody, A. (2001). Read but not cited.')}<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`,
    ].join('');
    const text = allTex(await convert(body, { sources }));
    expect(text).toContain('As shown see~\\cite[p.~12]{lam94}; \\cite[for the details]{knu84}.');
    expect(text).toContain('\\nocite{*}\n\\bibliographystyle{plain}\n\\bibliography{references}');
    expect(text).not.toContain('Read but not cited.');
    expect(text).not.toContain('\\section{References}');
  });

  it('keeps the bibliography Word wrote when its citations are not understood', async () => {
    // Citavi's placeholders are not read, so its citations and its list stay as Word shows them.
    const body = [
      para(run('Wie gezeigt ') + field('ADDIN CitaviPlaceholder{eyJ9}', '(Wolf 2019, S. 12)') + run('.')),
      heading(1, 'Literaturverzeichnis'),
      `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ADDIN CitaviBibliography </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${run('Wolf, A. (2019): Über Dinge. Berlin.')}</w:p>`,
      `<w:p>${run('Berg, B. (2020): Mehr Dinge. Wien.')}<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`,
      para(run('Nach dem Verzeichnis.')),
    ].join('');
    const text = allTex(await convert(body, { lang: 'de-DE' }));
    expect(text).toContain('Wie gezeigt (Wolf 2019, S. 12).');
    expect(text).toContain('\\section*{Literaturverzeichnis}');
    expect(text).toContain('Wolf, A. (2019): Über Dinge. Berlin.\n\nBerg, B. (2020): Mehr Dinge. Wien.\n\nNach dem Verzeichnis.');
    expect(text).not.toContain('\\bibliography');
  });

  it('imports a German thesis: captions, the bibliography before the appendix, and its heading names', async () => {
    const sources =
      '<b:Sources xmlns:b="http://schemas.openxmlformats.org/officeDocument/2006/bibliography"><b:Source><b:Tag>Qua19</b:Tag><b:SourceType>Book</b:SourceType>' +
      '<b:Author><b:Author><b:NameList><b:Person><b:Last>Quaschning</b:Last><b:First>V.</b:First></b:Person></b:NameList></b:Author></b:Author><b:Title>Regenerative Energiesysteme</b:Title><b:Year>2019</b:Year></b:Source></b:Sources>';
    const body = [
      heading(1, 'Inhalt'),
      para(field('TOC \\o "1-3" \\h \\z \\u', 'Einleitung 1')),
      heading(1, 'Einleitung'),
      para(run('Wie gezeigt ') + field('CITATION Qua19 \\p 12 \\l 1031', '(Quaschning, 2019, S. 12)') + run('.')),
      para(run('Tabelle ') + field('SEQ Tabelle \\* ARABIC', '1') + run(': Gemessene Leistung'), 'Caption'),
      table([3000, 3000], [tableRow([cell(para(run('Temperatur'))), cell(para(run('Leistung')))]), tableRow([cell(para(run('25 °C'))), cell(para(run('300 W')))])]),
      para(picture('lab', 4, 3)),
      para(run('Tablets im Labor'), 'Caption'),
      heading(1, 'Quellenverzeichnis'),
      para(field('BIBLIOGRAPHY', 'Quaschning, V. (2019). Regenerative Energiesysteme.')),
      heading(1, 'Anhang'),
      para(run('Messprotokoll.')),
    ].join('');
    const result = await convert(body, { sources, lang: 'de-DE', media: { 'lab.png': TINY_PNG } });
    const main = file(result, 'main.tex');
    const text = allTex(result);
    // "Tabelle", not "Tab" followed by "elle"; a caption that only starts like a label keeps its words.
    expect(text).toContain('\\caption{Gemessene Leistung}\n\\begin{tabular}');
    expect(text).toContain('\\caption{Tablets im Labor}');
    // The bibliography stays where it was in Word, before the appendix, and is listed in the contents.
    expect(main).toMatch(/\\include\{chapters\/01-einleitung\}\n\n\\nocite\{\*\}\n\\bibliographystyle\{plain\}\n\\clearpage\n\\phantomsection\n\\addcontentsline\{toc\}\{chapter\}\{\\bibname\}\n\\bibliography\{references\}\n\n\\include\{chapters\/02-anhang\}/);
    // babel sets its own names when the document begins, so Word's are set after that.
    expect(main).toContain('\\usepackage[ngerman]{babel}');
    expect(main).toContain('\\AtBeginDocument{%\n  \\renewcommand{\\bibname}{Quellenverzeichnis}\n  \\renewcommand{\\contentsname}{Inhalt}\n}');
  });

  it('shows the fallback picture of content it cannot convert, such as a 3D model', async () => {
    const drawing = picture('bird', 5, 5).replace(/^<w:r>|<\/w:r>$/g, '');
    const model =
      '<w:r><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="am3d">' +
      '<w:drawing><wp:inline><wp:extent cx="1800000" cy="1800000"/><wp:docPr id="2" name="3D Model"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/drawing/2017/model3d"/></a:graphic></wp:inline></w:drawing>' +
      `</mc:Choice><mc:Fallback>${drawing}</mc:Fallback></mc:AlternateContent></w:r>`;
    const result = await convert(para(model), { media: { 'bird.png': TINY_PNG } });
    expect(allTex(result)).toMatch(/\\includegraphics\[width=0\.31\\linewidth\]\{images\/[^}]+\.png\}/);
    expect(result.warnings).toEqual([]);
  });

  it('uses the PNG that Word 365 keeps next to an SVG picture, without a warning', async () => {
    const svg = picture('icon', 2, 2).replace(
      '<a:blip r:embed="img-icon"/>',
      '<a:blip r:embed="img-icon"><a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="img-icon-svg"/></a:ext></a:extLst></a:blip>',
    );
    const result = await convert(para(svg), { media: { 'icon.png': TINY_PNG, 'icon-svg.svg': strToU8('<svg xmlns="http://www.w3.org/2000/svg"/>') } });
    expect(result.files.map((item) => item.path).filter((path) => path.startsWith('images/'))).toEqual([expect.stringMatching(/\.png$/)]);
    expect(result.warnings).toEqual([]);
  });

  it('reads parts that other programs write in UTF-16, or name with other case or %-encoding', async () => {
    const files = unzipSync(buildDocx({ body: para(run('Grüße')) + para(picture('photo', 3, 3)), media: { 'my photo.png': TINY_PNG } }));
    const utf16 = (text: string) => {
      const out = new Uint8Array(2 + text.length * 2);
      out.set([0xff, 0xfe]);
      for (let k = 0; k < text.length; k++) out.set([text.charCodeAt(k) & 0xff, text.charCodeAt(k) >> 8], 2 + 2 * k);
      return out;
    };
    files['word/document.xml'] = utf16(strFromU8(files['word/document.xml']!));
    const rels = strFromU8(files['word/_rels/document.xml.rels']!).replace('Target="media/my photo.png"', 'Target="media/my%20photo.png"').replace('Id="img-my photo"', 'Id="img-photo"');
    files['word/_rels/document.xml.rels'] = strToU8(rels);
    files['word/Media/My Photo.PNG'] = files['word/media/my photo.png']!;
    delete files['word/media/my photo.png'];
    const result = await convertDocx(zipSync(files), { fileName: 'test.docx' });
    expect(allTex(result)).toContain('Grüße');
    expect(result.summary.images).toBe(1);
  });

  it('converts the rest of a file whose picture is damaged', async () => {
    const files = unzipSync(buildDocx({ body: para(run('Still here.')) + para(picture('broken', 3, 3)), media: { 'broken.png': new Uint8Array(4000) } }));
    const bytes = zipSync(files, { level: 6 });
    // Make the picture's compressed data invalid: a deflate block of the reserved type.
    const name = strToU8('word/media/broken.png');
    for (let at = 0; at < bytes.length - 30; at++) {
      if (bytes[at] !== 0x50 || bytes[at + 1] !== 0x4b || bytes[at + 2] !== 3 || bytes[at + 3] !== 4) continue;
      const nameLength = bytes[at + 26]! | (bytes[at + 27]! << 8);
      const extraLength = bytes[at + 28]! | (bytes[at + 29]! << 8);
      if (strFromU8(bytes.subarray(at + 30, at + 30 + nameLength)) !== strFromU8(name)) continue;
      bytes[at + 30 + nameLength + extraLength] = 0xff;
    }
    const result = await convertDocx(bytes, { fileName: 'test.docx' });
    expect(allTex(result)).toContain('Still here.');
    expect(result.warnings.join(' ')).toContain('could not be read (damaged)');
  });

  it('keeps a Title-styled paragraph after the first heading in its place', async () => {
    const body = [para(run('My Thesis'), 'Title'), heading(1, 'Introduction'), para(run('Text.')), para(run('Appendix'), 'Title'), para(run('More.'))].join('');
    const text = allTex(await convert(body));
    expect(text).toContain('\\title{My Thesis}');
    expect(text).toContain('Text.\n\n{\\LARGE\\bfseries Appendix\\par}\n\nMore.');
  });

  it('names the kind of file when it is not a Word document', async () => {
    const odt = zipSync({ mimetype: strToU8('application/vnd.oasis.opendocument.text'), 'content.xml': strToU8('<office:document-content/>') });
    await expect(convertDocx(odt, { fileName: 'thesis.docx' })).rejects.toThrow('This is an OpenDocument file (.odt)');
    const workbook = zipSync({
      '_rels/.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
      'xl/workbook.xml': strToU8('<workbook/>'),
    });
    await expect(convertDocx(workbook, { fileName: 'data.xlsx' })).rejects.toThrow('This is an Excel workbook');
    const flat = strToU8('<?xml version="1.0"?><?mso-application progid="Word.Document"?><pkg:package xmlns:pkg="http://schemas.microsoft.com/office/2006/xmlPackage"/>');
    await expect(convertDocx(flat, { fileName: 'thesis.xml' })).rejects.toThrow('This is a Word XML file');
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
