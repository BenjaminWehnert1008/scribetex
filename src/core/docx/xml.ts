/**
 * A small, forgiving XML reader for the parts of a .docx file.
 *
 * Word writes well-formed XML, so this does not validate anything. It keeps
 * element names with their prefixes ("w:p", "m:oMath"), which is how the rest
 * of the importer matches them. It works the same in a page, a worker and in
 * Node, which DOMParser does not.
 */

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

export type XmlNode = XmlElement | string;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

const ATTR = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * The prefixes this importer matches, by namespace. Word always writes these
 * prefixes, but other tools may write the same namespaces under other names
 * ("ns0:p"), and Strict Open XML uses other namespace addresses.
 */
const CANONICAL_PREFIXES: Record<string, string> = {
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main': 'w',
  'http://purl.oclc.org/ooxml/wordprocessingml/main': 'w',
  'http://schemas.openxmlformats.org/officeDocument/2006/math': 'm',
  'http://purl.oclc.org/ooxml/officeDocument/math': 'm',
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships': 'r',
  'http://purl.oclc.org/ooxml/officeDocument/relationships': 'r',
  'http://schemas.openxmlformats.org/drawingml/2006/main': 'a',
  'http://purl.oclc.org/ooxml/drawingml/main': 'a',
  'http://schemas.openxmlformats.org/drawingml/2006/picture': 'pic',
  'http://purl.oclc.org/ooxml/drawingml/picture': 'pic',
  'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing': 'wp',
  'http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing': 'wp',
  'http://schemas.openxmlformats.org/markup-compatibility/2006': 'mc',
  'urn:schemas-microsoft-com:vml': 'v',
  'urn:schemas-microsoft-com:office:office': 'o',
  'http://schemas.microsoft.com/office/word/2010/wordprocessingShape': 'wps',
  'http://purl.org/dc/elements/1.1/': 'dc',
  // Package parts are read by their unprefixed names ("Relationship"), whatever prefix a writer chose.
  'http://schemas.openxmlformats.org/package/2006/relationships': '',
  'http://schemas.openxmlformats.org/package/2006/content-types': '',
};

/** Renames "ns0:p" to "w:p" when ns0 is the WordprocessingML namespace. */
function canonical(name: string, scope: Map<string, string>, isElement: boolean): string {
  const colon = name.indexOf(':');
  if (colon === -1) {
    // Unprefixed names only take the default namespace when they are elements.
    const uri = isElement ? scope.get('') : undefined;
    const prefix = uri ? CANONICAL_PREFIXES[uri] : undefined;
    return prefix && (prefix === 'w' || prefix === 'm') ? `${prefix}:${name}` : name;
  }
  const prefix = name.slice(0, colon);
  if (prefix === 'xml' || prefix === 'xmlns') return name;
  const uri = scope.get(prefix);
  const wanted = uri ? CANONICAL_PREFIXES[uri] : undefined;
  if (wanted === '' && isElement) return name.slice(colon + 1);
  return wanted && wanted !== prefix ? `${wanted}${name.slice(colon)}` : name;
}

/** Parses a document and returns its root element. */
export function parseXml(source: string): XmlElement {
  const root: XmlElement = { name: '#document', attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  // Namespace declarations in scope, one map per open element (shared until one declares something).
  const scopes: Map<string, string>[] = [new Map()];
  // Raw tag names of the open elements, to match end tags written with the original prefix.
  const rawNames: string[] = ['#document'];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const lt = source.indexOf('<', i);
    if (lt === -1) {
      pushText(stack[stack.length - 1]!, source.slice(i));
      break;
    }
    if (lt > i) pushText(stack[stack.length - 1]!, source.slice(i, lt));
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9);
      const text = source.slice(lt + 9, end === -1 ? n : end);
      stack[stack.length - 1]!.children.push(text);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (source[lt + 1] === '?' || source[lt + 1] === '!') {
      const end = source.indexOf('>', lt);
      i = end === -1 ? n : end + 1;
      continue;
    }
    const gt = findTagEnd(source, lt);
    if (source[lt + 1] === '/') {
      const name = source.slice(lt + 2, gt).trim();
      // Close up to the matching element; a stray end tag is ignored.
      for (let k = stack.length - 1; k > 0; k--) {
        if (rawNames[k] === name) {
          stack.length = k;
          rawNames.length = k;
          scopes.length = k;
          break;
        }
      }
      i = gt + 1;
      continue;
    }
    const selfClosing = source[gt - 1] === '/';
    const inner = source.slice(lt + 1, selfClosing ? gt - 1 : gt);
    const space = inner.search(/\s/);
    const rawName = space === -1 ? inner : inner.slice(0, space);
    const rawAttrs: [string, string][] = [];
    let scope = scopes[scopes.length - 1]!;
    if (space !== -1) {
      const rest = inner.slice(space);
      ATTR.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = ATTR.exec(rest)) !== null) {
        const attrName = match[1]!;
        const value = decodeEntities(match[2] ?? match[3] ?? '');
        if (attrName === 'xmlns' || attrName.startsWith('xmlns:')) {
          if (scope === scopes[scopes.length - 1]) scope = new Map(scope);
          scope.set(attrName === 'xmlns' ? '' : attrName.slice(6), value);
        }
        rawAttrs.push([attrName, value]);
      }
    }
    const attrs: Record<string, string> = {};
    for (const [attrName, value] of rawAttrs) attrs[canonical(attrName, scope, false)] = value;
    const element: XmlElement = { name: canonical(rawName, scope, true), attrs, children: [] };
    stack[stack.length - 1]!.children.push(element);
    if (!selfClosing) {
      stack.push(element);
      rawNames.push(rawName);
      scopes.push(scope);
    }
    i = gt + 1;
  }
  const first = root.children.find((child): child is XmlElement => typeof child !== 'string');
  return first ?? root;
}

function findTagEnd(source: string, from: number): number {
  let quote: string | null = null;
  for (let k = from + 1; k < source.length; k++) {
    const c = source[k];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return k;
  }
  return source.length;
}

function pushText(parent: XmlElement, raw: string): void {
  // Whitespace between elements carries no meaning in Office XML, except
  // inside text elements, which always hold some other character as well or
  // are marked xml:space="preserve".
  if (raw.trim() === '' && !(parent.attrs['xml:space'] === 'preserve' || /:(t|instrText|delText)$/.test(parent.name))) return;
  parent.children.push(decodeEntities(raw));
}

export function elements(node: XmlElement): XmlElement[] {
  return node.children.filter((child): child is XmlElement => typeof child !== 'string');
}

export function child(node: XmlElement | undefined, name: string): XmlElement | undefined {
  if (!node) return undefined;
  for (const item of node.children) if (typeof item !== 'string' && item.name === name) return item;
  return undefined;
}

export function childrenNamed(node: XmlElement | undefined, name: string): XmlElement[] {
  if (!node) return [];
  return node.children.filter((item): item is XmlElement => typeof item !== 'string' && item.name === name);
}

/** Every descendant with this name, in document order. */
export function descendants(node: XmlElement, name: string, out: XmlElement[] = []): XmlElement[] {
  for (const item of node.children) {
    if (typeof item === 'string') continue;
    if (item.name === name) out.push(item);
    descendants(item, name, out);
  }
  return out;
}

export function textOf(node: XmlElement | undefined): string {
  if (!node) return '';
  let out = '';
  for (const item of node.children) out += typeof item === 'string' ? item : textOf(item);
  return out;
}

/** The w:val (or another) attribute of a child, for the many Word settings stored that way. */
export function val(node: XmlElement | undefined, name: string, attr = 'w:val'): string | undefined {
  return child(node, name)?.attrs[attr];
}

/**
 * Whether an on/off property such as w:b is set. Word writes it as an empty
 * element, or with w:val="0"/"false"/"off" to switch it off.
 */
export function flag(props: XmlElement | undefined, name: string): boolean | undefined {
  const element = child(props, name);
  if (!element) return undefined;
  const value = element.attrs['w:val'] ?? element.attrs['m:val'];
  return !(value === '0' || value === 'false' || value === 'off' || value === 'none');
}
