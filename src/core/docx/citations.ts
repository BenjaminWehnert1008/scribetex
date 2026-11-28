/**
 * References in Word files, turned into BibTeX entries.
 *
 * Three sources are understood:
 * - Word's own "Insert Citation" sources (b:Sources in customXml/item*.xml,
 *   cited with CITATION fields),
 * - Zotero and Mendeley citations, which store CSL JSON in their fields
 *   ("ADDIN ZOTERO_ITEM CSL_CITATION {…}", "ADDIN CSL_CITATION {…}"),
 * - EndNote citations ("ADDIN EN.CITE <EndNote>…</EndNote>").
 */
import { escapeText, safeKey } from './latex-text';
import { child, childrenNamed, descendants, elements, parseXml, textOf, type XmlElement } from './xml';

export interface BibEntry {
  key: string;
  type: string;
  fields: Record<string, string>;
}

/** One source of a citation, with the words the author put around it. */
export interface CiteItem {
  key: string;
  /** Text before the source, such as "see" or "vgl.". */
  prefix?: string;
  /** The page, or the place given by `label`, such as "12-14". */
  locator?: string;
  /** What the locator counts, in CSL's words: page (the default), chapter, section, … */
  label?: string;
  /** Text after the source, such as "for a review". */
  suffix?: string;
}

interface Person {
  family: string;
  given?: string;
  /** An organisation or a name that must not be split. */
  literal?: boolean;
}

export class Bibliography {
  readonly entries = new Map<string, BibEntry>();
  /** Word's source tag, a CSL item id or a title → the key used here. */
  readonly #aliases = new Map<string, string>();
  /** Sources from Word's own source list. Word's bibliography lists all of them, cited or not. */
  wordSources = 0;

  get size(): number {
    return this.entries.size;
  }

  lookup(alias: string): string | undefined {
    return this.#aliases.get(alias);
  }

  #add(aliases: string[], type: string, people: Person[], fields: Record<string, string | undefined>, preferredKey?: string): string {
    for (const alias of aliases) {
      const known = this.#aliases.get(alias);
      if (known) return known;
    }
    const year = /\d{4}/.exec(fields.year ?? '')?.[0] ?? '';
    const firstWord = (fields.title ?? '').split(/\s+/).find((word) => word.length > 3) ?? 'ref';
    const base = safeKey(preferredKey ?? `${(people[0]?.family ?? firstWord).split(/\s+/).pop() ?? 'ref'}${year}`, 'ref').toLowerCase();
    let key = base;
    for (let n = 2; this.entries.has(key); n++) key = `${base}${String.fromCharCode(96 + Math.min(n, 26))}${n > 26 ? n : ''}`;
    const out: Record<string, string> = {};
    if (people.length > 0) out.author = people.map(formatPerson).join(' and ');
    for (const [name, value] of Object.entries(fields)) {
      if (value && value.trim()) out[name] = value.trim();
    }
    this.entries.set(key, { key, type, fields: out });
    for (const alias of aliases) this.#aliases.set(alias, key);
    return key;
  }

  /** Reads Word's source list (the b:Sources element of a customXml part). */
  addWordSources(xml: string): void {
    const root = parseXml(xml);
    if (!root.name.endsWith('Sources')) return;
    for (const source of elements(root)) {
      if (!source.name.endsWith(':Source') && source.name !== 'Source') continue;
      const get = (name: string) => textOf(findLocal(source, name)).trim() || undefined;
      const tag = get('Tag');
      if (!tag) continue;
      const kind = get('SourceType') ?? 'Misc';
      const people = wordPeople(source, 'Author');
      const editors = wordPeople(source, 'Editor');
      const type = WORD_TYPES[kind] ?? 'misc';
      const fields: Record<string, string | undefined> = {
        title: get('Title'),
        year: get('Year'),
        month: get('Month'),
        publisher: get('Publisher'),
        address: get('City'),
        journal: kind === 'JournalArticle' ? get('JournalName') : undefined,
        booktitle: kind === 'ConferenceProceedings' ? (get('ConferenceName') ?? get('BookTitle')) : kind === 'BookSection' ? get('BookTitle') : undefined,
        volume: get('Volume'),
        number: get('Issue'),
        pages: get('Pages')?.replace(/\s*[-–]\s*/, '--'),
        edition: get('Edition'),
        institution: kind === 'Report' ? (get('Institution') ?? get('Publisher')) : undefined,
        school: get('Institution') && kind !== 'Report' ? get('Institution') : undefined,
        howpublished: kind === 'InternetSite' || kind === 'DocumentFromInternetSite' ? (get('InternetSiteTitle') ?? get('ProductionCompany')) : kind === 'ArticleInAPeriodical' ? get('PeriodicalTitle') : undefined,
        url: get('URL'),
        doi: get('DOI'),
        note: get('YearAccessed') ? `Accessed ${[get('DayAccessed'), get('MonthAccessed'), get('YearAccessed')].filter(Boolean).join(' ')}` : undefined,
      };
      if (editors.length > 0) fields.editor = editors.map(formatPerson).join(' and ');
      const key = this.#add([`word:${tag}`], type, people, fields, tag);
      this.#aliases.set(`word:${tag}`, key);
      this.wordSources++;
    }
  }

  /**
   * Adds the items of a Zotero or Mendeley citation. Returns one item per
   * source, with its page (or other locator) and the words around it.
   */
  addCslCitation(json: string): CiteItem[] {
    let data: unknown;
    try {
      data = JSON.parse(json);
    } catch {
      // Some tools add text after the JSON; try up to the last closing brace.
      try {
        data = JSON.parse(json.slice(0, json.lastIndexOf('}') + 1));
      } catch {
        return [];
      }
    }
    const items = (data as { citationItems?: unknown[] } | null)?.citationItems;
    if (!Array.isArray(items)) return [];
    const text = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value) : undefined);
    const cited: CiteItem[] = [];
    for (const item of items) {
      const record = item as { id?: unknown; uris?: unknown[]; uri?: unknown[]; itemData?: Record<string, unknown>; locator?: unknown; label?: unknown; prefix?: unknown; suffix?: unknown };
      const itemData = record.itemData;
      if (!itemData) continue;
      const aliases = [
        ...(Array.isArray(record.uris) ? record.uris : Array.isArray(record.uri) ? record.uri : []).map((uri) => `csl:${String(uri)}`),
        `csl-id:${String(record.id ?? itemData.id ?? '')}`,
        `title:${String(itemData.title ?? '').toLowerCase()}`,
      ];
      cited.push({
        key: this.#addCsl(itemData, aliases),
        locator: text(record.locator),
        label: text(record.label),
        prefix: text(record.prefix),
        suffix: text(record.suffix),
      });
    }
    return cited;
  }

  #addCsl(item: Record<string, unknown>, aliases: string[]): string {
    // Mendeley writes some characters LaTeX-escaped already ("\\&"); they are escaped here once more, so the backslash goes.
    const str = (name: string) => (typeof item[name] === 'string' || typeof item[name] === 'number' ? String(item[name]).replace(/\\([&%$#_{}])/g, '$1') : undefined);
    const people = cslPeople(item.author);
    const editors = cslPeople(item.editor);
    const issued = item.issued as { 'date-parts'?: unknown[][]; raw?: string; literal?: string } | undefined;
    const parts = issued?.['date-parts']?.[0];
    const year = parts?.[0] !== undefined ? String(parts[0]) : (/\d{4}/.exec(issued?.raw ?? issued?.literal ?? '')?.[0] ?? undefined);
    const cslType = str('type') ?? 'article';
    const type = CSL_TYPES[cslType] ?? 'misc';
    const container = str('container-title');
    const fields: Record<string, string | undefined> = {
      title: str('title'),
      year,
      journal: type === 'article' ? container : undefined,
      booktitle: type === 'incollection' || type === 'inproceedings' ? container : undefined,
      howpublished: type === 'misc' ? container : undefined,
      volume: str('volume'),
      number: str('issue') ?? str('number'),
      pages: str('page')?.replace(/\s*[-–]\s*/, '--'),
      publisher: str('publisher'),
      address: str('publisher-place'),
      edition: str('edition'),
      institution: type === 'techreport' ? str('publisher') : undefined,
      school: type === 'phdthesis' || type === 'mastersthesis' ? str('publisher') : undefined,
      doi: str('DOI'),
      url: str('URL'),
      isbn: str('ISBN'),
    };
    if (editors.length > 0) fields.editor = editors.map(formatPerson).join(' and ');
    return this.#add(aliases, type, people, fields);
  }

  /** Adds the records of an EndNote citation field. Returns one item per source, with the words around it. */
  addEndNote(instruction: string): CiteItem[] {
    const start = instruction.indexOf('<EndNote');
    if (start === -1) return [];
    const root = parseXml(instruction.slice(start));
    const cited: CiteItem[] = [];
    for (const cite of descendants(root, 'Cite')) {
      const record = child(cite, 'record');
      const recNum = textOf(child(cite, 'RecNum')).trim();
      // EndNote keeps a space at the end of a prefix as a backquote ("see`").
      const words = (name: string) => textOf(child(cite, name)).replace(/`/g, ' ').trim() || undefined;
      const around = { prefix: words('Prefix'), suffix: words('Suffix'), locator: words('Pages') };
      if (!record) {
        const known = this.lookup(`endnote:${recNum}`);
        if (known) cited.push({ key: known, ...around });
        continue;
      }
      const get = (path: string[]) => {
        let node: XmlElement | undefined = record;
        for (const name of path) node = child(node, name);
        return textOf(node).trim() || undefined;
      };
      const people = descendants(child(record, 'contributors') ?? record, 'author').map((author) => splitName(textOf(author)));
      const refType = child(record, 'ref-type')?.attrs.name ?? 'Journal Article';
      const type = ENDNOTE_TYPES[refType] ?? 'misc';
      const fields: Record<string, string | undefined> = {
        title: get(['titles', 'title']),
        journal: type === 'article' ? get(['titles', 'secondary-title']) : undefined,
        booktitle: type !== 'article' ? get(['titles', 'secondary-title']) : undefined,
        year: get(['dates', 'year']) ?? (textOf(child(cite, 'Year')).trim() || undefined),
        volume: get(['volume']),
        number: get(['number']),
        pages: get(['pages'])?.replace(/\s*[-–]\s*/, '--'),
        publisher: get(['publisher']),
        address: get(['pub-location']),
        doi: get(['electronic-resource-num']),
        url: get(['urls', 'related-urls', 'url']),
      };
      const key = this.#add([`endnote:${recNum}`, `title:${(fields.title ?? '').toLowerCase()}`], type, people, fields);
      cited.push({ key, ...around });
    }
    return cited;
  }

  /** The references.bib file. */
  toBibTeX(): string {
    const order = ['author', 'editor', 'title', 'journal', 'booktitle', 'howpublished', 'year', 'month', 'volume', 'number', 'pages', 'edition', 'publisher', 'institution', 'school', 'address', 'isbn', 'doi', 'url', 'note'];
    const blocks: string[] = [];
    for (const entry of this.entries.values()) {
      const names = Object.keys(entry.fields).sort((a, b) => order.indexOf(a) - order.indexOf(b));
      const width = Math.max(...names.map((name) => name.length));
      const lines = names.map((name) => `  ${name.padEnd(width)} = {${bibValue(name, entry.fields[name]!)}}`);
      blocks.push(`@${entry.type}{${entry.key},\n${lines.join(',\n')}\n}`);
    }
    return `${blocks.join('\n\n')}\n`;
  }
}

function bibValue(name: string, value: string): string {
  if (name === 'url') return value.replace(/[{}]/g, '').replace(/([%#])/g, '\\$1');
  if (name === 'doi') return value.replace(/^https?:\/\/(dx\.)?doi\.org\//, '').replace(/[{}]/g, '').replace(/([%#_])/g, '\\$1');
  if (name === 'author' || name === 'editor') return value; // escaped per name already
  const escaped = escapeText(value);
  // Keep the title's capitals as written: BibTeX styles would lower-case them.
  return name === 'title' ? `{${escaped}}` : escaped;
}

function formatPerson(person: Person): string {
  if (person.literal || !person.given) return `{${escapeText(person.family)}}`;
  return `${escapeText(person.family)}, ${escapeText(person.given)}`;
}

function splitName(raw: string): Person {
  const name = raw.trim();
  if (name.includes(',')) {
    const [family, ...rest] = name.split(',');
    return { family: family!.trim(), given: rest.join(',').trim() || undefined };
  }
  const words = name.split(/\s+/);
  if (words.length === 1) return { family: name, literal: true };
  return { family: words.pop()!, given: words.join(' ') };
}

function cslPeople(value: unknown): Person[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): Person[] => {
    const person = raw as { family?: string; given?: string; literal?: string };
    if (person.family) return [{ family: person.family, given: person.given }];
    if (person.literal) return [{ family: person.literal, literal: true }];
    return [];
  });
}

/** Local-name lookup: Word writes these under a prefix ("b:Title") that varies. */
function findLocal(node: XmlElement | undefined, local: string): XmlElement | undefined {
  if (!node) return undefined;
  return elements(node).find((item) => item.name === local || item.name.endsWith(`:${local}`));
}

function wordPeople(source: XmlElement, role: string): Person[] {
  const authors = findLocal(findLocal(source, 'Author'), role);
  if (!authors) return [];
  const corporate = textOf(findLocal(authors, 'Corporate')).trim();
  if (corporate) return [{ family: corporate, literal: true }];
  const list = findLocal(authors, 'NameList');
  return childrenNamedLocal(list, 'Person').map((person) => {
    const family = textOf(findLocal(person, 'Last')).trim();
    const given = [textOf(findLocal(person, 'First')).trim(), textOf(findLocal(person, 'Middle')).trim()].filter(Boolean).join(' ');
    return { family, given: given || undefined };
  });
}

function childrenNamedLocal(node: XmlElement | undefined, local: string): XmlElement[] {
  if (!node) return [];
  return [...childrenNamed(node, local), ...elements(node).filter((item) => item.name.endsWith(`:${local}`))];
}

const WORD_TYPES: Record<string, string> = {
  Book: 'book',
  BookSection: 'incollection',
  JournalArticle: 'article',
  ArticleInAPeriodical: 'article',
  ConferenceProceedings: 'inproceedings',
  Report: 'techreport',
  InternetSite: 'misc',
  DocumentFromInternetSite: 'misc',
  ElectronicSource: 'misc',
  Patent: 'misc',
  Case: 'misc',
  Misc: 'misc',
  Film: 'misc',
  Interview: 'misc',
  Performance: 'misc',
  SoundRecording: 'misc',
  Art: 'misc',
};

const CSL_TYPES: Record<string, string> = {
  'article-journal': 'article',
  article: 'article',
  'article-magazine': 'article',
  'article-newspaper': 'article',
  book: 'book',
  chapter: 'incollection',
  'paper-conference': 'inproceedings',
  report: 'techreport',
  thesis: 'phdthesis',
  webpage: 'misc',
  'post-weblog': 'misc',
  dataset: 'misc',
  manuscript: 'unpublished',
};

const ENDNOTE_TYPES: Record<string, string> = {
  'Journal Article': 'article',
  Book: 'book',
  'Book Section': 'incollection',
  'Conference Proceedings': 'inproceedings',
  'Conference Paper': 'inproceedings',
  Report: 'techreport',
  Thesis: 'phdthesis',
};
