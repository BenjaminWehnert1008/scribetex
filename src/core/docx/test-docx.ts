/**
 * Builds small .docx files for the tests, from WordprocessingML written by
 * hand. Only tests use this; it is not part of the app.
 */
import { strToU8, zipSync } from 'fflate';

const NS = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
].join(' ');

/** A 1×1 PNG. */
export const TINY_PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

export interface DocxParts {
  /** The inside of w:body. */
  body: string;
  /** Extra w:style elements. */
  styles?: string;
  /** The inside of w:numbering. */
  numbering?: string;
  /** w:footnote elements (ids 1 and up). */
  footnotes?: string;
  /** Pictures by file name in word/media, referenced as r:embed="img-<name without extension>". */
  media?: Record<string, Uint8Array>;
  /** Extra Relationship elements for the document. */
  rels?: string;
  /** A b:Sources document (Word's reference list). */
  sources?: string;
  /** Default language, such as en-US or de-DE. */
  lang?: string;
  title?: string;
  creator?: string;
}

const HEADINGS = [1, 2, 3, 4]
  .map(
    (n) =>
      `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>`,
  )
  .join('');

export function buildDocx(parts: DocxParts): Uint8Array {
  const media = parts.media ?? {};
  const rels = [
    '<Relationship Id="rStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    parts.numbering ? '<Relationship Id="rNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>' : '',
    parts.footnotes ? '<Relationship Id="rFootnotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>' : '',
    ...Object.keys(media).map(
      (name) => `<Relationship Id="img-${name.replace(/\.[^.]+$/, '')}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${name}"/>`,
    ),
    parts.rels ?? '',
  ].join('');
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>',
    ),
    'word/document.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${parts.body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1417" w:bottom="1134" w:left="1417"/></w:sectPr></w:body></w:document>`,
    ),
    'word/_rels/document.xml.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
    ),
    'word/styles.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/><w:lang w:val="${parts.lang ?? 'en-US'}"/></w:rPr></w:rPrDefault></w:docDefaults>` +
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
        HEADINGS +
        '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/></w:style>' +
        '<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/></w:style>' +
        '<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:rPr><w:i/></w:rPr></w:style>' +
        '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/></w:style>' +
        '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/></w:style>' +
        '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:u w:val="single"/></w:rPr></w:style>' +
        `${parts.styles ?? ''}</w:styles>`,
    ),
    'docProps/core.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${parts.title ?? ''}</dc:title><dc:creator>${parts.creator ?? ''}</dc:creator></cp:coreProperties>`,
    ),
  };
  if (parts.numbering) files['word/numbering.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${NS}>${parts.numbering}</w:numbering>`);
  if (parts.footnotes) {
    files['word/footnotes.xml'] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes ${NS}><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>${parts.footnotes}</w:footnotes>`,
    );
  }
  if (parts.sources) files['customXml/item1.xml'] = strToU8(parts.sources);
  for (const [name, bytes] of Object.entries(media)) files[`word/media/${name}`] = bytes;
  return zipSync(files);
}

// Helpers for writing document bodies.

const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const run = (text: string, props = '') => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
export const para = (content: string, style?: string, pPr = '') =>
  `<w:p>${style || pPr ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${pPr}</w:pPr>` : ''}${content}</w:p>`;
export const heading = (level: number, text: string, bookmark?: string) =>
  para(bookmark ? `<w:bookmarkStart w:id="${bookmark.length}" w:name="${bookmark}"/>${run(text)}<w:bookmarkEnd w:id="${bookmark.length}"/>` : run(text), `Heading${level}`);
/** A complex field: begin, instruction, separate, result, end. */
export const field = (instruction: string, result: string) =>
  `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${esc(instruction)} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${run(result)}<w:r><w:fldChar w:fldCharType="end"/></w:r>`;
export const listItem = (text: string, numId: number, level = 0) =>
  para(run(text), 'ListParagraph', `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr>`);
export const picture = (name: string, widthCm: number, heightCm: number) =>
  `<w:r><w:drawing><wp:inline><wp:extent cx="${Math.round(widthCm * 360000)}" cy="${Math.round(heightCm * 360000)}"/><wp:docPr id="1" name="${name}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="img-${name}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
export const cell = (content: string, tcPr = '') => `<w:tc>${tcPr ? `<w:tcPr>${tcPr}</w:tcPr>` : ''}${content || '<w:p/>'}</w:tc>`;
export const tableRow = (cells: string[], trPr = '') => `<w:tr>${trPr ? `<w:trPr>${trPr}</w:trPr>` : ''}${cells.join('')}</w:tr>`;
export const table = (widths: number[], rows: string[]) =>
  `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblLook w:val="04A0" w:firstRow="1"/></w:tblPr><w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${rows.join('')}</w:tbl>`;

/** Word's numbering definitions for one bullet list (numId 1) and one numbered list (numId 2). */
export const BASIC_NUMBERING =
  '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="o"/></w:lvl></w:abstractNum>' +
  '<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2)"/></w:lvl></w:abstractNum>' +
  '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>';

/** OMML for x = (-b ± √(b²-4ac)) / 2a. */
export const QUADRATIC_FORMULA =
  '<m:oMathPara><m:oMath><m:r><m:t>x=</m:t></m:r><m:f><m:num><m:r><m:t>-b±</m:t></m:r><m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e><m:sSup><m:e><m:r><m:t>b</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup><m:r><m:t>-4ac</m:t></m:r></m:e></m:rad></m:num><m:den><m:r><m:t>2a</m:t></m:r></m:den></m:f></m:oMath></m:oMathPara>';

/**
 * A short thesis with most of what Word documents contain: title, chapters
 * and sections, formatting, a footnote, lists, a table with merged cells, a
 * captioned picture with a cross-reference, an equation and a citation.
 */
export function sampleThesis(): Uint8Array {
  const sources =
    '<?xml version="1.0" standalone="yes"?><b:Sources xmlns:b="http://schemas.openxmlformats.org/officeDocument/2006/bibliography" xmlns="http://schemas.openxmlformats.org/officeDocument/2006/bibliography">' +
    '<b:Source><b:Tag>Lam94</b:Tag><b:SourceType>Book</b:SourceType><b:Author><b:Author><b:NameList><b:Person><b:Last>Lamport</b:Last><b:First>Leslie</b:First></b:Person></b:NameList></b:Author></b:Author><b:Title>LaTeX: A Document Preparation System</b:Title><b:Year>1994</b:Year><b:Publisher>Addison-Wesley</b:Publisher></b:Source>' +
    '</b:Sources>';
  const body = [
    para(run('Moving from Word to LaTeX'), 'Title'),
    para(run('A sample thesis'), 'Subtitle'),
    heading(1, 'Introduction', '_Ref1'),
    para(
      run('This text has ') +
        run('bold', '<w:b/>') +
        run(', ') +
        run('italic', '<w:i/>') +
        run(' and special characters: 50% & $5 #1 a_b {x} ~ ^ “quotes” – €.') +
        '<w:r><w:footnoteReference w:id="1"/></w:r>' +
        run(' As ') +
        field('CITATION Lam94 \\l 1033', '(Lamport, 1994)') +
        run(' explains, see ') +
        field('REF _Ref2 \\h', 'Figure 1') +
        run('.'),
    ),
    heading(2, 'Lists'),
    listItem('First point', 1),
    listItem('Second point', 1),
    listItem('A detail', 1, 1),
    listItem('Step one', 2),
    listItem('Step two', 2),
    heading(1, 'Methods'),
    para(run('The formula we use:')),
    para(QUADRATIC_FORMULA),
    para(picture('chart', 8, 4)),
    para(`${run('Figure ')}<w:bookmarkStart w:id="9" w:name="_Ref2"/>${field('SEQ Figure \\* ARABIC', '1')}<w:bookmarkEnd w:id="9"/>${run(': A picture of the setup')}`, 'Caption'),
    para(run('Table 1: Measured values'), 'Caption'),
    table(
      [3000, 3000, 3000],
      [
        tableRow([cell(para(run('Sample'))), cell(para(run('Value'))), cell(para(run('Note')))], '<w:tblHeader/>'),
        tableRow([cell(para(run('A')), '<w:vMerge w:val="restart"/>'), cell(para(run('1.5'))), cell(para(run('first')))]),
        tableRow([cell(para(''), '<w:vMerge/>'), cell(para(run('2.0'))), cell(para(run('second')))]),
        tableRow([cell(para(run('B'))), cell(para(run('both columns')), '<w:gridSpan w:val="2"/>')]),
      ],
    ),
    heading(1, 'Conclusion'),
    para(run('That is all.')),
    heading(1, 'References'),
    para(field('BIBLIOGRAPHY', 'Lamport, L. (1994). LaTeX.')),
  ].join('');
  return buildDocx({
    body,
    numbering: BASIC_NUMBERING,
    footnotes: `<w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r>${run(' A footnote with ')}${run('emphasis', '<w:i/>')}${run('.')}</w:p></w:footnote>`,
    media: { 'chart.png': TINY_PNG },
    sources,
    creator: 'Ada Lovelace',
  });
}
