/** The parts of a .docx package: relationships between parts, notes, and the file signature. */
import { strFromU8 } from 'fflate';
import { childrenNamed, parseXml, type XmlElement } from './xml';

/**
 * The text of an XML part. Word writes UTF-8; some other programs write UTF-16,
 * which starts with a byte order mark or with "<" and a zero byte.
 */
export function xmlText(bytes: Uint8Array): string {
  const [a, b] = [bytes[0], bytes[1]];
  if ((a === 0xff && b === 0xfe) || (a === 0x3c && b === 0x00)) return new TextDecoder('utf-16le').decode(bytes);
  if ((a === 0xfe && b === 0xff) || (a === 0x00 && b === 0x3c)) return new TextDecoder('utf-16be').decode(bytes);
  return strFromU8(bytes);
}

/** A part name as compared: Word treats names without regard to case or %-encoding. */
function canonicalName(name: string): string {
  let decoded = name;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    // A lone "%" stays as it is.
  }
  return decoded.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

const indexes = new WeakMap<Record<string, Uint8Array>, Map<string, string>>();

/** The zip entry for a part name, also when the writer spelled it with other case, %-encoding or backslashes. */
export function findPart(files: Record<string, Uint8Array>, name: string): string | undefined {
  if (Object.hasOwn(files, name)) return name;
  let index = indexes.get(files);
  if (!index) {
    index = new Map();
    for (const entry of Object.keys(files)) if (!index.has(canonicalName(entry))) index.set(canonicalName(entry), entry);
    indexes.set(files, index);
  }
  return index.get(canonicalName(name));
}

export interface Rel {
  type: string;
  target: string;
  external: boolean;
}

export function readRels(files: Record<string, Uint8Array>, partPath: string): Map<string, Rel> {
  const slash = partPath.lastIndexOf('/');
  const dir = partPath.slice(0, slash + 1);
  const relsPath = `${dir}_rels/${partPath.slice(slash + 1)}.rels`;
  const out = new Map<string, Rel>();
  const found = findPart(files, relsPath);
  if (!found) return out;
  for (const rel of childrenNamed(parseXml(xmlText(files[found]!)), 'Relationship')) {
    const external = rel.attrs.TargetMode === 'External';
    const target = rel.attrs.Target ?? '';
    const part = resolvePart(dir, target.replace(/\\/g, '/'));
    out.set(rel.attrs.Id ?? '', { type: rel.attrs.Type ?? '', target: external ? target : (findPart(files, part) ?? part), external });
  }
  return out;
}

export function resolvePart(dir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = `${dir}${target}`.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '..') out.pop();
    else if (part !== '.' && part !== '') out.push(part);
  }
  return out.join('/');
}

export function readNotes(files: Record<string, Uint8Array>, path: string | undefined, element: string): Map<string, XmlElement> {
  const out = new Map<string, XmlElement>();
  const bytes = path ? files[path] : undefined;
  if (!bytes) return out;
  for (const note of childrenNamed(parseXml(xmlText(bytes)), element)) {
    const type = note.attrs['w:type'];
    if (type === 'separator' || type === 'continuationSeparator' || type === 'continuationNotice') continue;
    out.set(note.attrs['w:id'] ?? '', note);
  }
  return out;
}

export function isZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

export function isOle(bytes: Uint8Array): boolean {
  return bytes.length > 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
}
