/**
 * Word (.docx) to a LaTeX project, entirely in the browser.
 *
 * A .docx file is a ZIP of XML parts (ECMA-376, "Office Open XML"). This
 * reads the main document, its styles, list numbering, footnotes, endnotes,
 * pictures and reference sources, and writes a project laid out the way a
 * LaTeX author would: main.tex with the preamble, one file per chapter (or
 * section) in chapters/, pictures in images/, references in references.bib.
 *
 * Nothing is sent anywhere. The conversion is written for this app from the
 * file format specification; no converter code was copied.
 */
import { strFromU8, unzipSync } from 'fflate';
import { encodeText } from '../hash';
import type { Path } from '../types';
import { Bibliography, type CiteItem } from './citations';
import { escapeText, escapeUrl, newEscapeStats, type EscapeStats } from './latex-text';
import { ommlParagraph, ommlToLatex, type MathStats } from './omml';
import { child, childrenNamed, descendants, elements, flag, parseXml, textOf, val, type XmlElement } from './xml';
import { assemble } from './assemble';
import {
  type Block,
  CAPTION_PREFIX,
  displayMath,
  F_BOLD,
  F_ITALIC,
  F_MONO,
  F_SMALLCAPS,
  F_STRIKE,
  F_SUB,
  F_SUP,
  F_UNDERLINE,
  flatBlock,
  type ImageRef,
  type Seg,
  segsToLatex,
  splitTopLevelBreaks,
  stripCaptionPrefix,
  stripHeadingNumber,
  textSeg,
  TOKEN,
  withLabels,
} from './blocks';
import { findPart, isOle, isZip, readNotes, readRels, xmlText, type Rel } from './package';
import { enumLabel, isOrdered, Numbering, readRunProps, type RunProps, Styles } from './styles';

export interface ConvertOptions {
  /** The file's name, used for the project name when the document has no title. */
  fileName?: string;
  /**
   * Turns a picture that pdfLaTeX cannot read (GIF, BMP, TIFF, WebP) into a
   * PNG. The browser does this with a canvas; without it such pictures are
   * kept as they are and marked in the text.
   */
  toPng?: (bytes: Uint8Array, mime: string) => Promise<Uint8Array | null>;
}

export interface ImportSummary {
  documentClass: 'article' | 'report';
  /** Files in chapters/ (or sections/). */
  parts: number;
  headings: number;
  paragraphs: number;
  images: number;
  tables: number;
  equations: number;
  footnotes: number;
  lists: number;
  references: number;
  citations: number;
}

export interface ConvertedProject {
  name: string;
  mainFile: Path;
  files: { path: Path; bytes: Uint8Array }[];
  dirs: Path[];
  summary: ImportSummary;
  /** Things the user may want to look at, in plain words. */
  warnings: string[];
}

export class DocxError extends Error {}

const REL_IMAGE = /\/image$/;

const SUPPORTED_IMAGES = new Set(['png', 'jpg', 'jpeg', 'pdf']);

const CONVERTIBLE_IMAGES: Record<string, string> = {
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  webp: 'image/webp',
  jfif: 'image/jpeg',
};

interface Field {
  instr: string;
  phase: 'code' | 'result';
  mode: 'keep' | 'capture' | 'drop';
  buffer: Seg[];
  /** A bibliography field whose result (the list Word wrote) is marked in the blocks. */
  typedBibliography?: boolean;
}

/** Word's bibliography field, or the one a reference manager inserts (Zotero, Mendeley, EndNote, Citavi, …). */
function isBibliography(instr: string): boolean {
  const word = instr.trim().split(/\s+/)[0]?.toUpperCase() ?? '';
  return word === 'BIBLIOGRAPHY' || (word === 'ADDIN' && /BIBL|REFLIST/i.test(instr) && !/CSL_CITATION/.test(instr));
}

/** Short names for what a citation's locator counts, per language; English is used for other languages. */
const LOCATOR_LABELS: Record<string, Record<string, readonly [string, string]>> = {
  en: { page: ['p.', 'pp.'], chapter: ['ch.', 'chs.'], section: ['sec.', 'secs.'], paragraph: ['para.', 'paras.'], figure: ['fig.', 'figs.'], volume: ['vol.', 'vols.'], line: ['l.', 'll.'], note: ['n.', 'nn.'], column: ['col.', 'cols.'] },
  de: { page: ['S.', 'S.'], chapter: ['Kap.', 'Kap.'], section: ['Abschn.', 'Abschn.'], paragraph: ['Abs.', 'Abs.'], figure: ['Abb.', 'Abb.'], volume: ['Bd.', 'Bde.'], line: ['Z.', 'Z.'], note: ['Anm.', 'Anm.'], column: ['Sp.', 'Sp.'] },
};

/** "S. 12", "pp. 3-5", "ch. 2": the locator with its label, in the document's language. */
function locatorText(locator: string, label: string | undefined, language: string | undefined): string {
  const kind = (label || 'page').toLowerCase();
  const names = LOCATOR_LABELS[(language ?? '').toLowerCase().split('-')[0] ?? ''] ?? LOCATOR_LABELS.en!;
  const pair = names[kind] ?? LOCATOR_LABELS.en![kind];
  const many = /[-\u2013\u2014,&]/.test(locator);
  return `${pair ? pair[many ? 1 : 0] : kind}\u00a0${locator.trim()}`;
}

/** Text a reference manager stored around a citation, without its markup and leading punctuation. */
function citeWords(text: string | undefined, leading: RegExp): string {
  return (text ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').replace(leading, '').trim();
}

/** A paragraph that starts like "Figure 3: …" but was not given the Caption style. */
const CAPTION_LIKE = /^\s*(figure|fig\.?|abbildung|abb\.?|table|tab\.?|tabelle)\s*\d+(?:[.\-–]\d+)*\s*[:.\-–—]\s+\S/i;

const FIGURE_WORD = /^(figure|fig|abbildung|abb|bild|grafik|chart|diagramm|figura|afbeelding)/i;

const TABLE_WORD = /^(table|tab|tabelle|tabla|tabella|tabel)/i;

const PLACEHOLDER_AUTHORS = /^(microsoft( office)?( user)?|user|admin(istrator)?|windows user|owner|benutzer|apache poi|python-docx|unknown|author|autor|word|default)$/i;

/**
 * Prefixes of the namespaces whose content is read here. A mc:Choice that
 * requires another one (a 3D model, ink, a new chart type) gives way to the
 * next choice or to the fallback, usually a picture.
 */
const UNDERSTOOD = new Set(['w', 'w10', 'w14', 'w15', 'w16', 'w16se', 'w16cid', 'w16cex', 'w16du', 'w16sdtdh', 'w16sdtfl', 'wne', 'wp', 'wp14', 'wps', 'wpg', 'wpc', 'a', 'a14', 'pic', 'v', 'o', 'm', 'r', 'mc']);

/** The content of mc:AlternateContent to read (ECMA-376 Part 3, 10.2): the first understood choice, else the fallback. */
function alternate(node: XmlElement): XmlElement[] {
  for (const choice of childrenNamed(node, 'mc:Choice')) {
    const requires = (choice.attrs.Requires ?? '').split(/\s+/).filter(Boolean);
    if (requires.every((prefix) => UNDERSTOOD.has(prefix))) return elements(choice);
  }
  const fallback = child(node, 'mc:Fallback');
  return fallback ? elements(fallback) : [];
}

export class Converter {
  readonly warnings = new Set<string>();
  readonly escapeStats: EscapeStats = newEscapeStats();
  readonly mathStats: MathStats = { unknown: 0 };
  readonly bib = new Bibliography();
  readonly counts = { images: 0, tables: 0, equations: 0, footnotes: 0, lists: 0, citations: 0, paragraphs: 0 };

  blocks: Block[] = [];
  fields: Field[] = [];
  /** Footnote texts waiting for \footnotetext, while inside a table, caption or heading. */
  deferred: string[] | null = null;
  inTable = 0;
  inFootnote = false;
  pendingBookmarks: string[] = [];
  listCounters = new Map<string, number[]>();

  title: string[] = [];
  subtitle: string[] = [];
  authors: string[] = [];
  date: string | null = null;
  /** The letter of a drop cap, waiting for the paragraph it starts. */
  dropCap = '';
  /** A bibliography field ended; its end is marked after the paragraph it ended in. */
  closeBibliography = false;
  /** The document has Word's own bibliography field, which lists every source of the document. */
  wordBibliography = false;
  /** A heading came, so a Title-styled paragraph from now on is part of the text. */
  seenHeading = false;
  usedPackages = new Set<string>();
  /** Bookmark names that a reference points to. */
  referenced = new Set<string>();
  refTokens: { bookmark: string; kind: 'ref' | 'pageref' | 'nameref' | 'link'; text: string; prefix: string }[] = [];
  /** Picture parts, mapped to their place in the project once known. */
  images = new Map<string, { bytes: Uint8Array; ext: string; supported: boolean; name: string | null }>();
  usedImages = new Set<string>();
  textWidthTwips = 9026;
  pageWidthTwips = 11906;

  constructor(
    public rels: Map<string, Rel>,
    readonly styles: Styles,
    readonly numbering: Numbering,
    readonly notes: { footnotes: Map<string, XmlElement>; endnotes: Map<string, XmlElement>; footnoteRels: Map<string, Rel>; endnoteRels: Map<string, Rel> },
  ) {}

  warn(message: string): void {
    this.warnings.add(message);
  }

  // -- fields ---------------------------------------------------------------

  sink(para: Seg[]): Seg[] | null {
    for (let k = this.fields.length - 1; k >= 0; k--) {
      const field = this.fields[k]!;
      if (field.phase === 'code' || field.mode === 'drop') return null;
      if (field.mode === 'capture') return field.buffer;
    }
    return para;
  }

  emit(para: Seg[], seg: Seg): void {
    this.sink(para)?.push(seg);
  }

  fieldMode(instr: string): Field['mode'] {
    const word = instr.trim().split(/\s+/)[0]?.toUpperCase() ?? '';
    switch (word) {
      case 'TOC':
      case 'CITATION':
      case 'PAGE':
      case 'NUMPAGES':
      case 'SECTIONPAGES':
      case 'INDEX':
      case 'XE':
      case 'TC':
        return 'drop';
      case 'REF':
      case 'PAGEREF':
      case 'NOTEREF':
      case 'HYPERLINK':
        return 'capture';
      case 'ADDIN': {
        const kind = instr.trim().split(/\s+/)[1]?.toUpperCase() ?? '';
        if (kind === 'EN.CITE' && instr.includes('<EndNote')) return 'drop';
        if (instr.includes('CSL_CITATION') && instr.includes('{')) return 'drop';
        return 'keep';
      }
      default:
        return 'keep';
    }
  }

  /** What a finished field leaves in the text. */
  /** A field's result starts: its mode is known now, and a bibliography's list is marked. */
  enterResult(field: Field): void {
    field.mode = this.fieldMode(field.instr);
    if (isBibliography(field.instr) && this.fields.length === 1 && !this.inTable && !this.inFootnote) {
      this.blocks.push({ kind: 'bibliography', typed: true });
      field.typedBibliography = true;
    }
  }

  /**
   * \cite for the sources of one citation. Words around a source stay with it:
   * "vgl. \cite[S.~12]{key}". Several sources with words or pages of their own
   * get one \cite each, since \cite has room for only one note.
   */
  citeLatex(items: CiteItem[]): string {
    const seen = new Set<string>();
    const unique = items.filter((item) => {
      if (seen.has(item.key)) return false;
      seen.add(item.key);
      return true;
    });
    const arg = (text: string) => escapeText(text, this.escapeStats);
    const notes = unique.map((item) =>
      [item.locator?.trim() ? locatorText(item.locator, item.label, this.styles.language) : '', citeWords(item.suffix, /^[\s,;:]+/)].filter(Boolean).join(', '),
    );
    const prefixes = unique.map((item) => citeWords(item.prefix, /^\s+/));
    const one = (key: string, prefix: string, note: string) =>
      `${prefix ? `${arg(prefix)}~` : ''}\\cite${note ? `[${/[[\]]/.test(note) ? `{${arg(note)}}` : arg(note)}]` : ''}{${key}}`;
    if (unique.length === 1 || (notes.every((note) => !note) && prefixes.slice(1).every((prefix) => !prefix))) {
      return one(unique.map((item) => item.key).join(','), prefixes[0] ?? '', notes[0] ?? '');
    }
    return unique.map((item, k) => one(item.key, prefixes[k]!, notes[k]!)).join('; ');
  }

  finishField(field: Field, para: Seg[]): void {
    const instr = field.instr.trim();
    const words = splitInstruction(instr);
    const word = words[0]?.toUpperCase() ?? '';
    const out = (seg: Seg) => this.emit(para, seg);
    if (word === 'TOC') {
      const caption = switchValue(words, '\\c');
      const which = caption ? (TABLE_WORD.test(caption) ? 'tables' : 'figures') : 'contents';
      this.blocks.push({ kind: 'toc', which });
      return;
    }
    if (isBibliography(instr)) {
      if (word === 'BIBLIOGRAPHY') this.wordBibliography = true;
      // The list Word wrote stays in the blocks between marks; see resolveBibliographies in assemble.ts.
      if (field.typedBibliography) this.closeBibliography = true;
      else this.blocks.push({ kind: 'bibliography' });
      return;
    }
    if (word === 'CITATION') {
      // CITATION Tag1 \p 12 \f "see" \m Tag2 \s "for a review": the switches belong to the source before them.
      const items: CiteItem[] = [];
      let current: CiteItem | null = null;
      let unknown = false;
      for (let k = 0; k < words.length; k++) {
        const item = words[k]!;
        const value = words[k + 1];
        if (k === 0) continue;
        if (k === 1 || item.toLowerCase() === '\\m') {
          const tag = k === 1 ? item : value;
          if (k !== 1) k++;
          const key = tag ? this.bib.lookup(`word:${tag}`) : undefined;
          current = key ? { key } : null;
          if (current) items.push(current);
          else unknown = true;
          continue;
        }
        const name = item.toLowerCase();
        if (current && value !== undefined && (name === '\\p' || name === '\\f' || name === '\\s')) {
          if (name === '\\p') current.locator = value;
          else if (name === '\\f') current.prefix = value;
          else current.suffix = value;
          k++;
        }
      }
      if (items.length === 0 || unknown) {
        // A source that is not in the document's list: keep what Word shows.
        out(textSeg(field.buffer.map((seg) => seg.plain).join('') || '[?]', 0, this.escapeStats));
        return;
      }
      this.counts.citations++;
      out({ latex: this.citeLatex(items), plain: '', flags: 0, raw: true });
      return;
    }
    if (word === 'ADDIN' && field.mode === 'drop') {
      const items = instr.includes('<EndNote') ? this.bib.addEndNote(instr) : this.bib.addCslCitation(instr.slice(instr.indexOf('{')));
      if (items.length === 0) return;
      this.counts.citations++;
      out({ latex: this.citeLatex(items), plain: '', flags: 0, raw: true });
      return;
    }
    if (word === 'REF' || word === 'PAGEREF' || word === 'NOTEREF') {
      const bookmark = words[1] ?? '';
      const text = field.buffer.map((seg) => seg.plain).join('').trim();
      const rendered = segsToLatex(field.buffer);
      let kind: 'ref' | 'pageref' | 'nameref' = word === 'PAGEREF' ? 'pageref' : 'ref';
      let prefix = '';
      if (kind === 'ref') {
        const match = /^(.*?)(\d+(?:[.\-–]\d+)*)\s*$/.exec(text);
        if (match) prefix = escapeText(match[1]!.trim(), this.escapeStats);
        else if (text) kind = 'nameref';
      }
      this.referenced.add(bookmark);
      const index = this.refTokens.push({ bookmark, kind, text: rendered, prefix }) - 1;
      out({ latex: `${TOKEN}R${index}${TOKEN}`, plain: text, flags: 0, raw: true });
      return;
    }
    if (word === 'HYPERLINK') {
      const anchor = switchValue(words, '\\l');
      const target = words[1] && !words[1].startsWith('\\') ? words[1] : '';
      this.link(target, anchor, field.buffer, para);
      return;
    }
    for (const seg of field.buffer) out(seg);
  }

  link(url: string, anchor: string | undefined, content: Seg[], para: Seg[]): void {
    const text = segsToLatex(content);
    const plain = content.map((seg) => seg.plain).join('');
    if (!url && anchor) {
      this.referenced.add(anchor);
      const index = this.refTokens.push({ bookmark: anchor, kind: 'link', text, prefix: '' }) - 1;
      this.emit(para, { latex: `${TOKEN}R${index}${TOKEN}`, plain, flags: 0, raw: true });
      return;
    }
    if (!url) {
      for (const seg of content) this.emit(para, seg);
      return;
    }
    const full = anchor ? `${url}#${anchor}` : url;
    // \url shows its argument as it is, so it is only used for addresses without characters that need escaping.
    const shownAsIs = (plain.trim() === full || plain.trim() === full.replace(/^mailto:/, '')) && !/[%#{}\\^~\s]/.test(full);
    const latex = shownAsIs ? `\\url{${full}}` : `\\href{${escapeUrl(full)}}{${text}}`;
    this.emit(para, { latex, plain, flags: 0, raw: true });
  }

  // -- inline content -------------------------------------------------------

  /** Walks the inline children of a paragraph (runs, links, fields, math ...). */
  inline(nodes: XmlElement[], para: Seg[], extra: { images: ImageRef[]; bookmarks: string[]; after: Block[] }, baseRun: RunProps, inLink = false): void {
    for (const node of nodes) {
      switch (node.name) {
        case 'w:r':
          this.run(node, para, extra, baseRun, inLink);
          break;
        case 'w:hyperlink': {
          const rel = node.attrs['r:id'] ? this.rels.get(node.attrs['r:id']) : undefined;
          const content: Seg[] = [];
          const sub = { images: extra.images, bookmarks: extra.bookmarks, after: extra.after };
          // The link's own text goes to a buffer of its own, then becomes one \href.
          const saved = this.fields;
          this.fields = [];
          this.inline(elements(node), content, sub, baseRun, true);
          this.fields = saved;
          this.link(rel?.external ? rel.target : '', node.attrs['w:anchor'], content, para);
          break;
        }
        case 'w:fldSimple': {
          const field: Field = { instr: node.attrs['w:instr'] ?? '', phase: 'result', mode: 'keep', buffer: [] };
          this.fields.push(field);
          this.enterResult(field);
          this.inline(elements(node), para, extra, baseRun, inLink);
          this.fields.pop();
          this.finishField(field, para);
          break;
        }
        case 'w:ins':
        case 'w:moveTo':
        case 'w:smartTag':
        case 'w:customXml':
        case 'w:dir':
        case 'w:bdo':
          this.inline(elements(node), para, extra, baseRun, inLink);
          break;
        case 'w:sdt':
          // A content control that still shows its placeholder ("Click or tap here to enter text.") is empty.
          if (child(child(node, 'w:sdtPr'), 'w:showingPlcHdr')) break;
          this.inline(elements(child(node, 'w:sdtContent') ?? node), para, extra, baseRun, inLink);
          break;
        case 'mc:AlternateContent':
          this.inline(alternate(node), para, extra, baseRun, inLink);
          break;
        case 'w:bookmarkStart': {
          const name = node.attrs['w:name'];
          if (name && name !== '_GoBack') extra.bookmarks.push(name);
          break;
        }
        case 'm:oMath':
        case 'm:oMathPara': {
          if (this.sink(para) === null) break;
          this.usedPackages.add('amsmath');
          this.counts.equations++;
          if (node.name === 'm:oMathPara') {
            const lines = ommlParagraph(node, this.mathStats);
            if (lines.length === 0) break;
            this.emit(para, { latex: `\n${displayMath(lines, false)}\n`, plain: ' ', flags: 0, raw: true, lineBreak: false, math: lines });
          } else {
            // A line break inside an equation in running text has no meaning in LaTeX.
            const latex = splitTopLevelBreaks(ommlToLatex(node, this.mathStats)).join(' ');
            if (latex) this.emit(para, { latex: `$${latex}$`, plain: 'x', flags: 0, raw: true });
          }
          break;
        }
        default:
          break;
      }
    }
  }

  run(node: XmlElement, para: Seg[], extra: { images: ImageRef[]; bookmarks: string[]; after: Block[] }, baseRun: RunProps, inLink: boolean): void {
    const rPr = child(node, 'w:rPr');
    const runStyle = val(rPr, 'w:rStyle');
    const props: RunProps = { ...baseRun, ...this.styles.runProps(runStyle), ...readRunProps(rPr) };
    if (props.vanish) return;
    // Word underlines links through the Hyperlink character style; LaTeX marks links its own way.
    if (runStyle && this.styles.is(runStyle, /^(followed)?hyperlink$|^internetlink$|^internet link$/)) inLink = true;
    let flags = 0;
    if (props.b) flags |= F_BOLD;
    if (props.i) flags |= F_ITALIC;
    if (props.u && !inLink) flags |= F_UNDERLINE;
    if (props.strike) flags |= F_STRIKE;
    if (props.smallCaps) flags |= F_SMALLCAPS;
    if (props.mono) flags |= F_MONO;
    if (props.vertAlign === 'superscript') flags |= F_SUP;
    if (props.vertAlign === 'subscript') flags |= F_SUB;
    for (const item of elements(node)) {
      switch (item.name) {
        case 'w:t': {
          const text = props.caps ? textOf(item).toUpperCase() : textOf(item);
          if (text) this.emit(para, textSeg(text, flags, this.escapeStats));
          break;
        }
        case 'w:tab':
        case 'w:ptab':
          this.emit(para, { latex: ' ', plain: ' ', flags });
          break;
        case 'w:noBreakHyphen':
          this.emit(para, { latex: '-', plain: '-', flags });
          break;
        case 'w:softHyphen':
          this.emit(para, { latex: '\\-', plain: '', flags });
          break;
        case 'w:br':
        case 'w:cr': {
          const type = item.attrs['w:type'];
          if (type === 'page') {
            if (!this.inTable && !this.inFootnote) this.emit(para, { latex: '\\clearpage{}', plain: ' ', flags: 0, raw: true, lineBreak: true });
          }
          else if (type !== 'column') this.emit(para, { latex: '\\newline{}', plain: ' ', flags: 0, raw: true, lineBreak: true });
          break;
        }
        case 'w:sym': {
          const code = parseInt(item.attrs['w:char'] ?? '', 16);
          const font = (item.attrs['w:font'] ?? '').toLowerCase();
          this.emit(para, { latex: symbolChar(font, code), plain: '*', flags: 0, raw: true });
          break;
        }
        case 'w:fldChar': {
          const type = item.attrs['w:fldCharType'];
          if (type === 'begin') this.fields.push({ instr: '', phase: 'code', mode: 'keep', buffer: [] });
          else if (type === 'separate') {
            const top = this.fields[this.fields.length - 1];
            if (top && top.phase === 'code') {
              top.phase = 'result';
              this.enterResult(top);
            }
          } else if (type === 'end') {
            const top = this.fields.pop();
            if (top) {
              if (top.phase === 'code') top.mode = this.fieldMode(top.instr);
              this.finishField(top, para);
            }
          }
          break;
        }
        case 'w:instrText': {
          const top = this.fields[this.fields.length - 1];
          if (top && top.phase === 'code') top.instr += textOf(item);
          break;
        }
        case 'w:footnoteReference':
        case 'w:endnoteReference': {
          const id = item.attrs['w:id'] ?? '';
          const note = item.name === 'w:footnoteReference' ? this.notes.footnotes.get(id) : this.notes.endnotes.get(id);
          if (!note || this.sink(para) === null) break;
          this.counts.footnotes++;
          const text = this.footnoteText(note, item.name === 'w:footnoteReference' ? this.notes.footnoteRels : this.notes.endnoteRels);
          if (this.deferred) {
            this.deferred.push(text);
            this.emit(para, { latex: '\\footnotemark{}', plain: '', flags: 0, raw: true });
          } else this.emit(para, { latex: `\\footnote{${text}}`, plain: '', flags: 0, raw: true });
          break;
        }
        case 'w:drawing':
          this.drawing(item, para, extra);
          break;
        case 'w:pict':
        case 'w:object': {
          this.vml(item, para, extra);
          break;
        }
        case 'mc:AlternateContent':
          this.run({ ...node, children: alternate(item) }, para, extra, baseRun, inLink);
          break;
        case 'm:oMath':
        case 'm:oMathPara':
          this.inline([item], para, extra, baseRun, inLink);
          break;
        default:
          break;
      }
    }
  }

  footnoteText(note: XmlElement, rels: Map<string, Rel>): string {
    const saved = { blocks: this.blocks, fields: this.fields, deferred: this.deferred, inFootnote: this.inFootnote, pending: this.pendingBookmarks, rels: this.rels };
    this.rels = rels;
    this.blocks = [];
    this.fields = [];
    this.deferred = null;
    this.inFootnote = true;
    this.pendingBookmarks = [];
    this.body(elements(note));
    const text = this.blocks
      .map((block) => flatBlock(block))
      .filter(Boolean)
      .join(' \\par ');
    Object.assign(this, { blocks: saved.blocks, fields: saved.fields, deferred: saved.deferred, inFootnote: saved.inFootnote, pendingBookmarks: saved.pending, rels: saved.rels });
    return text;
  }

  drawing(node: XmlElement, para: Seg[], extra: { images: ImageRef[]; after: Block[] }): void {
    if (this.sink(para) === null) return;
    const container = child(node, 'wp:inline') ?? child(node, 'wp:anchor');
    const anchored = container?.name === 'wp:anchor';
    const extent = child(container, 'wp:extent');
    const cx = Number(extent?.attrs.cx ?? 0);
    const blips = descendants(node, 'a:blip');
    const textBoxes = descendants(node, 'w:txbxContent');
    if (blips.length === 0 && textBoxes.length === 0) {
      const data = descendants(node, 'a:graphicData')[0]?.attrs.uri ?? '';
      if (data.includes('chart')) this.warn('Charts are not converted. Each one is marked with a box in the text; paste it in as a picture to keep it.');
      else if (data.includes('diagram')) this.warn('SmartArt graphics are not converted. Each one is marked with a box in the text.');
      else this.warn('Some drawn shapes were left out.');
      if (data.includes('chart') || data.includes('diagram')) {
        this.emit(para, { latex: `\\fbox{${data.includes('chart') ? 'Chart' : 'SmartArt'} from Word, not converted}`, plain: 'x', flags: 0, raw: true });
      }
      return;
    }
    for (const blip of blips) {
      const id = blip.attrs['r:embed'] ?? blip.attrs['r:link'];
      const rel = id ? this.rels.get(id) : undefined;
      if (!rel || rel.external) {
        this.warn('Pictures that are only linked from the Word file, not saved in it, were left out.');
        continue;
      }
      if (!this.images.has(rel.target)) continue;
      const width = blips.length === 1 && cx > 0 ? Math.min(1, cx / (this.textWidthTwips * 635)) : 0;
      this.pushImage(para, extra, { part: rel.target, width, anchored });
    }
    // Text boxes hold paragraphs of their own; they follow the paragraph.
    for (const box of textBoxes) {
      const saved = this.blocks;
      this.blocks = [];
      this.body(elements(box));
      extra.after.push(...this.blocks);
      this.blocks = saved;
    }
  }

  vml(node: XmlElement, para: Seg[], extra: { images: ImageRef[]; after: Block[] }): void {
    if (this.sink(para) === null) return;
    const images = descendants(node, 'v:imagedata');
    if (node.name === 'w:object' && descendants(node, 'o:OLEObject').some((ole) => /Equation/i.test(ole.attrs.ProgID ?? ''))) {
      this.warn('Equations from the old Equation Editor 3.0 cannot be read. They are kept as pictures where possible; retype them for real formulas.');
    }
    for (const image of images) {
      const rel = image.attrs['r:id'] ? this.rels.get(image.attrs['r:id']) : undefined;
      if (!rel || rel.external || !this.images.has(rel.target)) continue;
      const style = descendants(node, 'v:shape')[0]?.attrs.style ?? '';
      const widthPt = /width:\s*([\d.]+)pt/.exec(style)?.[1];
      const width = widthPt ? Math.min(1, (Number(widthPt) * 20) / this.textWidthTwips) : 0;
      this.pushImage(para, extra, { part: rel.target, width, anchored: false });
    }
    for (const box of descendants(node, 'w:txbxContent')) {
      const saved = this.blocks;
      this.blocks = [];
      this.body(elements(box));
      extra.after.push(...this.blocks);
      this.blocks = saved;
    }
  }

  pushImage(para: Seg[], extra: { images: ImageRef[] }, image: ImageRef): void {
    extra.images.push(image);
    this.counts.images++;
    this.usedPackages.add('graphicx');
    this.usedImages.add(image.part);
    if (!image.anchored) this.emit(para, { latex: `${TOKEN}F${image.part}${TOKEN}${image.width}${TOKEN}`, plain: '', flags: 0, raw: true });
  }

  // -- block content --------------------------------------------------------

  body(nodes: XmlElement[]): void {
    for (const node of nodes) {
      this.bodyElement(node);
      if (this.closeBibliography && !this.inTable && !this.inFootnote) {
        this.blocks.push({ kind: 'bibliography-end' });
        this.closeBibliography = false;
      }
    }
  }

  bodyElement(node: XmlElement): void {
    switch (node.name) {
      case 'w:p':
        this.paragraph(node);
        break;
      case 'w:tbl':
        this.table(node);
        break;
      case 'w:sdt':
        if (child(child(node, 'w:sdtPr'), 'w:showingPlcHdr')) break;
        this.body(elements(child(node, 'w:sdtContent') ?? node));
        break;
      case 'w:customXml':
      case 'w:ins':
      case 'w:moveTo':
        this.body(elements(node));
        break;
      case 'mc:AlternateContent':
        this.body(alternate(node));
        break;
      case 'w:bookmarkStart': {
        const name = node.attrs['w:name'];
        if (name && name !== '_GoBack') this.pendingBookmarks.push(name);
        break;
      }
      case 'w:altChunk':
        this.warn('Parts of the document that were pasted in as embedded files (altChunk) were left out.');
        break;
      case 'm:oMathPara': {
        const para: Seg[] = [];
        this.inline([node], para, { images: [], bookmarks: [], after: [] }, {});
        if (para.length) this.blocks.push({ kind: 'raw', latex: para.map((seg) => seg.latex).join('').trim() });
        break;
      }
      default:
        break;
    }
  }

  paragraph(p: XmlElement): void {
    const pPr = child(p, 'w:pPr');
    const styleId = val(pPr, 'w:pStyle');
    const styles = this.styles;
    const headingLevel = this.inTable || this.inFootnote ? null : (val(pPr, 'w:outlineLvl') !== undefined && Number(val(pPr, 'w:outlineLvl')) < 9 ? Number(val(pPr, 'w:outlineLvl')) + 1 : styles.headingLevel(styleId));
    // Title, subtitle, author and date go to \maketitle until the first heading; after it they are part of the text.
    const titleBlock = !this.inTable && !this.inFootnote && !this.seenHeading;
    const titleStyle = styles.is(styleId, /^title$|^titel$/) ? 'title' : styles.is(styleId, /^subtitle$|^untertitel$/) ? 'subtitle' : null;
    const isTitle = titleBlock && titleStyle === 'title';
    const isSubtitle = titleBlock && titleStyle === 'subtitle';
    const isAuthor = titleBlock && styles.is(styleId, /^author$|^autor$|^authors$/);
    const isDate = titleBlock && this.title.length > 0 && styles.is(styleId, /^date$|^datum$/);
    const dropCap = child(pPr, 'w:framePr')?.attrs['w:dropCap'];
    const isCaption = styles.is(styleId, /^caption$|^beschriftung$/);
    const isToc = styles.is(styleId, /^toc \d|^verzeichnis \d|^table of figures$|^abbildungsverzeichnis$/);
    const isQuote = styles.is(styleId, /^(intense )?quote$|^zitat$|^intensives zitat$|^block text$|^blocktext$/);
    const isCode = !this.inTable && !this.inFootnote && styles.is(styleId, /code|source|quelltext|preformatted|listing|verbatim|programm/);
    const isList = styles.is(styleId, /^list (bullet|number)/);
    const numPr = child(pPr, 'w:numPr');
    const styleNum = styles.numbering(styleId);
    const directId = val(numPr, 'w:numId');
    const directLevel = val(numPr, 'w:ilvl');
    // A paragraph can set only the level and take the list from its style.
    const numId = directId ?? styleNum?.numId;
    const num = headingLevel === null && numId !== undefined ? { numId, ilvl: Number(directLevel ?? (directId ? 0 : (styleNum?.ilvl ?? 0))) } : null;
    const listNum = num && num.numId !== '0' ? num : isList && !num ? { numId: '__bullet', ilvl: 0 } : null;

    if (flag(pPr, 'w:pageBreakBefore') && !this.inTable && !this.inFootnote) this.blocks.push({ kind: 'raw', latex: '\\clearpage' });

    // Headings and captions keep their own look: their style's bold or size is not copied.
    const baseRun = headingLevel !== null || isTitle || isSubtitle || isAuthor || isCaption ? {} : this.styles.runProps(styleId);
    const segs: Seg[] = [];
    const extra = { images: [] as ImageRef[], bookmarks: [...this.pendingBookmarks], after: [] as Block[] };
    this.pendingBookmarks = [];
    const savedDeferred = this.deferred;
    if (headingLevel !== null || isCaption) this.deferred = [];
    const deferred = this.deferred;
    this.inline(elements(p).filter((node) => node.name !== 'w:pPr'), segs, extra, baseRun);
    this.deferred = savedDeferred;
    const notes = headingLevel !== null || isCaption ? (deferred ?? []) : [];

    const plain = segs.map((seg) => seg.plain).join('').replace(/\s+/g, ' ').trim();
    if (headingLevel !== null || isTitle || isSubtitle || isAuthor) for (const seg of segs) seg.flags &= ~F_BOLD;
    // An equation with its number typed after it, "(3)", becomes a numbered equation.
    const displays = segs.filter((seg) => seg.math);
    if (displays.length === 1) {
      const rest = segs.filter((seg) => !seg.math && !seg.lineBreak);
      const restText = rest.map((seg) => seg.plain).join('');
      if (/^\s*\(\s*[\d.\-–]+\s*\)\s*$/.test(restText) && rest.every((seg) => !seg.raw || seg.latex.startsWith(TOKEN))) {
        displays[0]!.latex = `\n${displayMath(displays[0]!.math!, true)}\n`;
        segs.splice(0, segs.length, ...segs.filter((seg) => seg.math || (seg.raw && seg.latex.startsWith(TOKEN))));
      }
    }
    const hasText = plain !== '' || segs.some((seg) => seg.raw && !seg.lineBreak && seg.latex.trim() !== '' && !seg.latex.startsWith(TOKEN));
    const imagesOnly = extra.images.length > 0 && plain === '' && !segs.some((seg) => seg.raw && !seg.latex.startsWith(TOKEN) && !seg.lineBreak);

    const finish = () => {
      for (const block of extra.after) this.blocks.push(block);
    };

    if (isToc) {
      finish();
      return;
    }

    if (isCode && hasText) {
      const text = segs
        .map((seg) => (seg.lineBreak ? '\n' : seg.plain))
        .join('')
        .replace(/\t/g, '    ');
      const last = this.blocks[this.blocks.length - 1];
      if (last?.kind === 'code') last.text += `\n${text}`;
      else this.blocks.push({ kind: 'code', text });
      finish();
      return;
    }

    if (imagesOnly) {
      this.blocks.push({ kind: 'figure', images: extra.images, bookmarks: extra.bookmarks });
      finish();
      return;
    }

    if (!hasText && extra.images.length === 0) {
      // An empty paragraph; a page break inside it still counts.
      if (segs.some((seg) => seg.latex === '\\clearpage{}')) this.blocks.push({ kind: 'raw', latex: '\\clearpage' });
      if (extra.bookmarks.length) this.pendingBookmarks.push(...extra.bookmarks);
      finish();
      return;
    }

    let latex = segsToLatex(segs);
    if (this.dropCap && !isTitle && !isSubtitle && !isAuthor && !isDate && headingLevel === null) {
      latex = `${escapeText(this.dropCap, this.escapeStats)}${latex}`;
      this.dropCap = '';
    }
    if (isTitle) {
      this.title.push(segsToLatex(segs, true));
      finish();
      return;
    }
    if (isAuthor) {
      this.authors.push(segsToLatex(segs, true));
      finish();
      return;
    }
    if (isDate) {
      this.date = segsToLatex(segs, true);
      finish();
      return;
    }
    if (dropCap === 'drop' || dropCap === 'margin') {
      // A drop cap is the first letter of the next paragraph, set in a frame of its own.
      this.dropCap += plain;
      finish();
      return;
    }
    if (isSubtitle) {
      this.subtitle.push(segsToLatex(segs, true));
      finish();
      return;
    }
    if (headingLevel !== null) {
      this.seenHeading = true;
      const full = segsToLatex(segs, true);
      const text = stripHeadingNumber(full) || full;
      const plainText = stripHeadingNumber(plain) || plain;
      const hasNotes = notes.length > 0;
      this.blocks.push({
        kind: 'heading',
        level: headingLevel,
        latex: text,
        short: hasNotes || /\\(footnote|newline)/.test(text) ? escapeText(plainText, this.escapeStats) : null,
        plain: plainText,
        bookmarks: extra.bookmarks,
        deferred: notes,
      });
      this.counts.paragraphs++;
      finish();
      return;
    }
    const captionWord = CAPTION_PREFIX.exec(plain);
    const looksLikeCaption = !!captionWord && CAPTION_LIKE.test(plain) && plain.length < 400;
    if ((isCaption || looksLikeCaption) && !this.inTable && !this.inFootnote) {
      const word = captionWord?.[1] ?? '';
      const target = FIGURE_WORD.test(word) ? 'figure' : TABLE_WORD.test(word) ? 'table' : null;
      const stripped = stripCaptionPrefix(segs);
      this.blocks.push({
        kind: 'caption',
        latex: stripped,
        full: latex,
        plain: plain.replace(CAPTION_PREFIX, ''),
        short: notes.length > 0 ? escapeText(plain.replace(CAPTION_PREFIX, ''), this.escapeStats) : null,
        target,
        bookmarks: extra.bookmarks,
        deferred: notes,
      });
      // A caption that is not next to a picture or table is turned back into text later.
      for (const image of extra.images.filter((item) => item.anchored)) this.blocks.push({ kind: 'figure', images: [image], bookmarks: [] });
      finish();
      return;
    }
    this.counts.paragraphs++;
    if (listNum && !this.inFootnote) {
      const level = listNum.numId === '__bullet' ? { format: 'bullet', text: '', start: 1 } : this.numbering.level(listNum.numId, listNum.ilvl);
      const ordered = isOrdered(level);
      const counters = this.listCounters.get(listNum.numId) ?? [];
      const depth = Math.min(listNum.ilvl, 8);
      counters[depth] = (counters[depth] ?? level.start - 1) + 1;
      counters.length = depth + 1;
      this.listCounters.set(listNum.numId, counters);
      const label = ordered ? enumLabel(level, listNum.ilvl, this.numbering, listNum.numId) : null;
      this.blocks.push({ kind: 'item', latex: withLabels(latex, extra.bookmarks), plain, ordered, depth, numId: listNum.numId, value: counters[depth]!, label });
    } else {
      const jc = val(pPr, 'w:jc') ?? styles.alignment(styleId);
      const align = this.inTable || this.inFootnote ? undefined : jc === 'center' ? 'center' : jc === 'right' || jc === 'end' ? 'right' : undefined;
      // A Title-styled paragraph after the first heading, such as a second part's title, keeps its look.
      const styled = titleStyle && !this.inTable && !this.inFootnote && latex.trim() ? `{${titleStyle === 'title' ? '\\LARGE\\bfseries' : '\\Large'} ${latex}\\par}` : latex;
      this.blocks.push({ kind: 'para', latex: withLabels(styled, extra.bookmarks), plain, align, quote: isQuote && !this.inTable, bookmarks: [] });
    }
    for (const image of extra.images.filter((item) => item.anchored)) this.blocks.push({ kind: 'figure', images: [image], bookmarks: [] });
    finish();
  }

  // -- tables ---------------------------------------------------------------

  table(tbl: XmlElement): void {
    const grid = childrenNamed(child(tbl, 'w:tblGrid'), 'w:gridCol').map((col) => Number(col.attrs['w:w'] ?? 0));
    const rows = childrenNamed(tbl, 'w:tr').concat(
      // Rows can be wrapped in content controls.
      childrenNamed(tbl, 'w:sdt').flatMap((sdt) => childrenNamed(child(sdt, 'w:sdtContent'), 'w:tr')),
    );
    if (rows.length === 0) return;

    if (this.inTable || this.inFootnote) {
      // A table inside a table cell or footnote: its text is kept, line by line.
      for (const row of rows) {
        const cells = rowCells(row).map((cell) => this.cellText(cell.node));
        this.blocks.push({ kind: 'para', latex: cells.filter(Boolean).join(' \\textbar{} '), plain: 'x', bookmarks: [] });
      }
      return;
    }

    this.counts.tables++;
    this.usedPackages.add('booktabs');
    this.usedPackages.add('array');
    const columnCount = Math.max(grid.length, ...rows.map((row) => rowCells(row).reduce((sum, cell) => sum + cell.span, 0)));
    const widths = grid.length === columnCount && grid.every((w) => w > 0) ? grid : new Array<number>(columnCount).fill(1);
    const total = widths.reduce((a, b) => a + b, 0);
    const scale = grid.length === columnCount && total > 0 ? Math.min(1, total / this.textWidthTwips) / total : 1 / total;
    const fractions = widths.map((w) => Math.max(0.04, w * scale));
    const spec = fractions.map((f) => `L{${f.toFixed(3)}}`).join('');

    // Cell text first, so merged cells can be measured.
    const saved = this.deferred;
    this.deferred = [];
    const deferred = this.deferred;
    this.inTable++;
    const matrix = rows.map((row) => {
      let col = 0;
      return rowCells(row).map((cell) => {
        const out = { ...cell, col, text: cell.vMerge === 'continue' ? '' : this.cellText(cell.node), bold: cellIsBold(cell.node) };
        col += cell.span;
        return out;
      });
    });
    this.inTable--;
    this.deferred = saved;

    const lines: string[] = [];
    // Header rows: rows marked to repeat on each page, else a first row that Word's "Header Row"
    // option (on by default) or bold text marks as one.
    let head = 0;
    while (head < rows.length && flag(child(rows[head], 'w:trPr'), 'w:tblHeader')) head++;
    const look = child(child(tbl, 'w:tblPr'), 'w:tblLook');
    const firstRowLook = look
      ? look.attrs['w:firstRow'] !== undefined
        ? look.attrs['w:firstRow'] === '1' || look.attrs['w:firstRow'] === 'true' || look.attrs['w:firstRow'] === 'on'
        : (parseInt(look.attrs['w:val'] ?? '0', 16) & 0x20) !== 0
      : false;
    const spansDown = (r: number) => matrix[r]!.some((cell) => cell.vMerge === 'restart');
    if (head === 0 && matrix.length > 1 && !spansDown(0) && (firstRowLook || matrix[0]!.every((cell) => cell.bold || cell.text === ''))) head = 1;
    // A header cell merged downwards takes the rows below it into the header.
    while (head > 0 && head < matrix.length && matrix[head]!.some((cell) => cell.vMerge === 'continue')) head++;
    matrix.forEach((cells, r) => {
      const parts = cells.map((cell) => {
        let text = cell.text;
        if (cell.vMerge === 'restart') {
          let span = 1;
          for (let k = r + 1; k < matrix.length; k++) {
            const below = matrix[k]!.find((other) => other.col === cell.col);
            if (below?.vMerge === 'continue') span++;
            else break;
          }
          if (span > 1) {
            this.usedPackages.add('multirow');
            text = `\\multirow{${span}}{=}{${text}}`;
          }
        }
        if (cell.span > 1) {
          const width = fractions.slice(cell.col, cell.col + cell.span).reduce((a, b) => a + b, 0);
          text = `\\multicolumn{${cell.span}}{L{${width.toFixed(3)}}}{${text}}`;
        }
        return text;
      });
      const used = cells.reduce((sum, cell) => sum + cell.span, 0);
      for (let k = used; k < columnCount; k++) parts.push('');
      lines.push(`${parts.join(' & ')} \\\\`);
    });
    this.blocks.push({ kind: 'table', head: lines.slice(0, head), body: lines.slice(head), spec, rows: lines.length, deferred });
  }

  cellText(cell: XmlElement): string {
    const saved = this.blocks;
    this.blocks = [];
    this.body(elements(cell).filter((node) => node.name !== 'w:tcPr'));
    const blocks = this.blocks;
    this.blocks = saved;
    return blocks
      .map((block) => flatBlock(block))
      .filter(Boolean)
      .join(' \\newline ');
  }
}

interface Cell {
  node: XmlElement;
  span: number;
  vMerge: 'restart' | 'continue' | null;
}

const EMPTY_CELL: XmlElement = { name: 'w:tc', attrs: {}, children: [] };

function rowCells(row: XmlElement): Cell[] {
  const cells: Cell[] = [];
  const trPr = child(row, 'w:trPr');
  const before = Number(val(trPr, 'w:gridBefore') ?? 0) || 0;
  if (before > 0) cells.push({ node: EMPTY_CELL, span: before, vMerge: null });
  const visit = (node: XmlElement) => {
    for (const item of elements(node)) {
      if (item.name === 'w:tc') {
        const tcPr = child(item, 'w:tcPr');
        const span = Number(val(tcPr, 'w:gridSpan') ?? 1) || 1;
        const merge = child(tcPr, 'w:vMerge');
        cells.push({ node: item, span, vMerge: merge ? (merge.attrs['w:val'] === 'restart' ? 'restart' : 'continue') : null });
      } else if (item.name === 'w:sdt') visit(child(item, 'w:sdtContent') ?? item);
      else if (item.name === 'w:customXml') visit(item);
    }
  };
  visit(row);
  const after = Number(val(trPr, 'w:gridAfter') ?? 0) || 0;
  if (after > 0) cells.push({ node: EMPTY_CELL, span: after, vMerge: null });
  return cells;
}

function cellIsBold(cell: XmlElement): boolean {
  const runs = descendants(cell, 'w:r').filter((run) => textOf(child(run, 'w:t')).trim() !== '');
  return runs.length > 0 && runs.every((run) => flag(child(run, 'w:rPr'), 'w:b') === true);
}

function splitInstruction(instr: string): string[] {
  const out: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(instr)) !== null) out.push(match[1] ?? match[2]!);
  return out;
}

function switchValue(words: string[], name: string): string | undefined {
  const index = words.findIndex((word) => word.toLowerCase() === name.toLowerCase());
  return index !== -1 ? words[index + 1] : undefined;
}

const SYMBOL_FONT: Record<number, string> = {
  0x61: '$\\alpha$', 0x62: '$\\beta$', 0x63: '$\\chi$', 0x64: '$\\delta$', 0x65: '$\\epsilon$', 0x66: '$\\phi$',
  0x67: '$\\gamma$', 0x68: '$\\eta$', 0x69: '$\\iota$', 0x6b: '$\\kappa$', 0x6c: '$\\lambda$', 0x6d: '$\\mu$',
  0x6e: '$\\nu$', 0x70: '$\\pi$', 0x71: '$\\theta$', 0x72: '$\\rho$', 0x73: '$\\sigma$', 0x74: '$\\tau$',
  0x77: '$\\omega$', 0x78: '$\\xi$', 0x79: '$\\psi$', 0x7a: '$\\zeta$', 0x44: '$\\Delta$', 0x46: '$\\Phi$',
  0x47: '$\\Gamma$', 0x4c: '$\\Lambda$', 0x50: '$\\Pi$', 0x53: '$\\Sigma$', 0x57: '$\\Omega$', 0x51: '$\\Theta$',
  0xb1: '$\\pm$', 0xb4: '$\\times$', 0xa3: '$\\leq$', 0xb3: '$\\geq$', 0xb9: '$\\neq$', 0xbb: '$\\approx$',
  0xae: '$\\rightarrow$', 0xac: '$\\leftarrow$', 0xde: '$\\Rightarrow$', 0xdb: '$\\Leftrightarrow$', 0xa5: '$\\infty$',
  0xb7: '\\textbullet{}', 0xd7: '$\\cdot$', 0xb0: '\\textdegree{}', 0xd6: '$\\surd$', 0xb6: '$\\partial$', 0xd1: '$\\nabla$',
  0xce: '$\\in$', 0xc7: '$\\cap$', 0xc8: '$\\cup$', 0xe5: '$\\sum$', 0xf2: '$\\int$',
};

function symbolChar(font: string, code: number): string {
  const low = code >= 0xf000 ? code - 0xf000 : code;
  if (font.includes('symbol')) return SYMBOL_FONT[low] ?? '\\textbullet{}';
  if (font.includes('wingdings')) {
    if (low === 0xfc || low === 0xfe) return '$\\checkmark$';
    if (low === 0xfb || low === 0xfd) return '$\\times$';
    if (low === 0xe0 || low === 0xe8 || low === 0xd8) return '$\\rightarrow$';
    return '\\textbullet{}';
  }
  return '\\textbullet{}';
}

/** Converts a .docx file to the files of a LaTeX project. */
/**
 * The entries of the zip. A damaged entry (say, one picture) does not stop the
 * rest: then the entries are read one by one and the damaged ones left out.
 * Names written with backslashes get forward slashes.
 */
function unzipParts(bytes: Uint8Array): { files: Record<string, Uint8Array>; damaged: number } {
  const tidy = (entries: Record<string, Uint8Array>) => {
    const out: Record<string, Uint8Array> = {};
    for (const [name, data] of Object.entries(entries)) out[name.replace(/\\/g, '/').replace(/^\/+/, '')] = data;
    return out;
  };
  try {
    return { files: tidy(unzipSync(bytes)), damaged: 0 };
  } catch {
    const names: string[] = [];
    try {
      unzipSync(bytes, {
        filter: (file) => {
          names.push(file.name);
          return false;
        },
      });
    } catch {
      throw new DocxError('The Word file could not be opened. It may be damaged.');
    }
    const files: Record<string, Uint8Array> = {};
    let damaged = 0;
    for (const name of names) {
      try {
        Object.assign(files, unzipSync(bytes, { filter: (file) => file.name === name }));
      } catch {
        damaged++;
      }
    }
    return { files: tidy(files), damaged };
  }
}

export async function convertDocx(bytes: Uint8Array, options: ConvertOptions = {}): Promise<ConvertedProject> {
  const fileName = options.fileName ?? 'document.docx';
  if (isOle(bytes)) {
    throw new DocxError(
      /\.doc$/i.test(fileName)
        ? 'This is an older Word file (.doc). Open it in Word and save it as .docx ("Word Document"), then import that file.'
        : 'This Word file is password protected or in an older format. Save it as an unprotected .docx and try again.',
    );
  }
  if (!isZip(bytes)) {
    const head = strFromU8(bytes.subarray(0, 2000));
    if (/<\?mso-application progid="Word\.Document"|<pkg:package|<w:wordDocument/.test(head)) {
      throw new DocxError('This is a Word XML file (.xml). Open it in Word and save it as .docx ("Word Document"), then import that file.');
    }
    throw new DocxError('This does not look like a Word file (.docx).');
  }
  const { files, damaged } = unzipParts(bytes);
  const text = (path: string | undefined) => {
    const found = path ? findPart(files, path) : undefined;
    return found ? xmlText(files[found]!) : undefined;
  };

  const packageRels = readRels(files, '');
  const officeDoc = [...packageRels.values()].find((rel) => rel.type.endsWith('/officeDocument'))?.target ?? findPart(files, 'word/document.xml') ?? 'word/document.xml';
  const documentXml = text(officeDoc);
  if (/^(xl|ppt)\//i.test(officeDoc) || (documentXml && /<\w*:?(workbook|presentation)\b/.test(documentXml.slice(0, 3000)))) {
    throw new DocxError(/^xl\//i.test(officeDoc) || /workbook/.test(documentXml?.slice(0, 3000) ?? '') ? 'This is an Excel workbook, not a Word document.' : 'This is a PowerPoint presentation, not a Word document.');
  }
  if (!documentXml) {
    if (damaged > 0) throw new DocxError('The Word file could not be opened. It may be damaged.');
    if (files.mimetype && strFromU8(files.mimetype).includes('opendocument')) {
      throw new DocxError('This is an OpenDocument file (.odt), not a Word file. Open it in LibreOffice and save it as Word (.docx), then import that file.');
    }
    throw new DocxError('This file has no Word document inside. Is it a .docx file?');
  }

  const rels = readRels(files, officeDoc);
  const relOf = (suffix: string) => [...rels.values()].find((rel) => rel.type.endsWith(suffix) && !rel.external)?.target;
  const styles = new Styles(text(relOf('/styles')));
  const numbering = new Numbering(text(relOf('/numbering')), styles);
  const footnotes = readNotes(files, relOf('/footnotes'), 'w:footnote');
  const endnotes = readNotes(files, relOf('/endnotes'), 'w:endnote');
  const footnoteRels = relOf('/footnotes') ? readRels(files, relOf('/footnotes')!) : new Map<string, Rel>();
  const endnoteRels = relOf('/endnotes') ? readRels(files, relOf('/endnotes')!) : new Map<string, Rel>();
  const conv = new Converter(rels, styles, numbering, { footnotes, endnotes, footnoteRels, endnoteRels });
  if (endnotes.size > 0) conv.warn('Endnotes became footnotes.');
  if (damaged > 0) conv.warn(`${damaged === 1 ? 'One part' : `${damaged} parts`} of the Word file could not be read (damaged) and were left out, such as a picture.`);

  // Word's own reference sources live in a customXml part.
  for (const [path, data] of Object.entries(files)) {
    if (!/^customXml\/item\d+\.xml$/i.test(path)) continue;
    const xml = xmlText(data);
    if (xml.includes('Sources') && xml.includes('SourceType')) conv.bib.addWordSources(xml);
  }

  // Pictures, prepared first because converting one may take a moment.
  const imageParts = new Set<string>();
  for (const partRels of [rels, footnoteRels, endnoteRels]) {
    for (const rel of partRels.values()) if (REL_IMAGE.test(rel.type) && !rel.external) imageParts.add(rel.target);
  }
  for (const part of imageParts) {
    const data = files[part];
    if (!data) continue;
    let ext = (part.split('.').pop() ?? '').toLowerCase();
    let out = data;
    let supported = SUPPORTED_IMAGES.has(ext);
    if (ext === 'jpeg' || ext === 'jfif') ext = 'jpg';
    if (!supported && CONVERTIBLE_IMAGES[ext] && options.toPng) {
      const png = await options.toPng(data, CONVERTIBLE_IMAGES[ext]!).catch(() => null);
      if (png) {
        out = png;
        ext = 'png';
        supported = true;
      }
    }
    if (ext === 'jpg' || SUPPORTED_IMAGES.has(ext)) supported = true;
    conv.images.set(part, { bytes: out, ext, supported, name: null });
  }

  const document = parseXml(documentXml);
  const body = child(document, 'w:body');
  if (!body) throw new DocxError('The Word document is empty.');
  const sectPr = child(body, 'w:sectPr');
  const pageWidth = Number(child(sectPr, 'w:pgSz')?.attrs['w:w'] ?? 0);
  const margins = child(sectPr, 'w:pgMar');
  if (pageWidth > 0) {
    conv.pageWidthTwips = pageWidth;
    conv.textWidthTwips = Math.max(2000, pageWidth - Number(margins?.attrs['w:left'] ?? 1440) - Number(margins?.attrs['w:right'] ?? 1440));
  }

  conv.body(elements(body));
  // Only pictures the text shows count: Word 365 keeps an SVG next to the PNG it shows.
  const unsupported = [...conv.usedImages].filter((part) => conv.images.get(part)?.supported === false).length;
  if (unsupported > 0) {
    conv.warn(`${unsupported === 1 ? 'One picture is' : `${unsupported} pictures are`} in a format pdfLaTeX cannot show (such as EMF or WMF). The files are in images/ and marked in the text; convert them to PNG or PDF.`);
  }
  if (conv.escapeStats.unknown.size > 0) {
    const sample = [...conv.escapeStats.unknown.keys()].slice(0, 8).join(' ');
    const total = [...conv.escapeStats.unknown.values()].reduce((a, b) => a + b, 0);
    conv.warn(`${total} character${total === 1 ? '' : 's'} that pdfLaTeX cannot print (${sample}) became a bold question mark. Search the text for \\textbf{?}.`);
  }
  if (conv.mathStats.unknown > 0) conv.warn(`${conv.mathStats.unknown} symbol${conv.mathStats.unknown === 1 ? '' : 's'} in equations had no LaTeX form and became \\text{?}.`);
  if (child(sectPr, 'w:headerReference') || child(sectPr, 'w:footerReference')) conv.warn('Headers and footers from Word were left out; LaTeX adds page numbers itself.');
  if (descendants(body, 'w:commentRangeStart').length > 0) conv.warn('Comments in the Word file were left out.');
  if (conv.counts.paragraphs > 40 && !conv.blocks.some((block) => block.kind === 'heading')) {
    conv.warn('The document uses no Word headings, so all text is in main.tex. Paragraphs styled Heading 1, 2, 3 in Word become chapters and sections.');
  }

  // Title and author
  const core = text('docProps/core.xml');
  const coreXml = core ? parseXml(core) : undefined;
  const coreTitle = textOf(coreXml ? child(coreXml, 'dc:title') : undefined).trim();
  const creator = textOf(coreXml ? child(coreXml, 'dc:creator') : undefined).trim();
  const baseName = fileName.replace(/\.(docx|docm|dotx|dotm)$/i, '').trim() || 'Imported document';
  const titleText = conv.title.length ? textOfLatex(conv.title.join(' ')) : coreTitle || baseName;
  const author = creator && !PLACEHOLDER_AUTHORS.test(creator) ? creator : null;

  const assembled = assemble(conv, { title: titleText, author, fileName, hasTitleStyle: conv.title.length > 0 });

  const files_: { path: Path; bytes: Uint8Array }[] = [];
  files_.push({ path: 'main.tex' as Path, bytes: encodeText(assembled.main) });
  for (const part of assembled.parts) files_.push({ path: part.path, bytes: encodeText(part.text) });
  for (const image of conv.images.values()) {
    if (!image.name) continue; // not used in the text (a header logo, for example)
    files_.push({ path: `images/${image.name}.${image.ext}` as Path, bytes: image.bytes });
  }
  if (conv.bib.size > 0) files_.push({ path: 'references.bib' as Path, bytes: encodeText(conv.bib.toBibTeX()) });

  const dirs = new Set<Path>();
  for (const file of files_) {
    const at = file.path.lastIndexOf('/');
    if (at > 0) dirs.add(file.path.slice(0, at) as Path);
  }

  return {
    name: titleText.length > 0 && titleText.length <= 80 ? titleText : baseName,
    mainFile: 'main.tex' as Path,
    files: files_,
    dirs: [...dirs],
    summary: {
      documentClass: assembled.documentClass,
      parts: assembled.parts.length,
      headings: conv.blocks.filter((block) => block.kind === 'heading').length,
      paragraphs: conv.counts.paragraphs,
      images: conv.usedImages.size,
      tables: conv.counts.tables,
      equations: conv.counts.equations,
      footnotes: conv.counts.footnotes,
      lists: conv.counts.lists,
      references: conv.bib.size,
      citations: conv.counts.citations,
    },
    warnings: [...conv.warnings],
  };
}

/** Plain text of a short piece of generated LaTeX, for names. */
function textOfLatex(latex: string): string {
  return latex
    .replace(/\\(textbf|emph|textit|textsc|texttt|uline|sout|textsuperscript|textsubscript)\{/g, '')
    .replace(/\\[a-zA-Z]+\{\}/g, '')
    .replace(/\\\\/g, ' ')
    .replace(/[{}]/g, '')
    .replace(/\\([&%$#_])/g, '$1')
    .replace(/~/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
