/** The parts of a .docx package: relationships between parts, notes, and the file signature. */
import { strFromU8 } from 'fflate';
import { childrenNamed, parseXml, type XmlElement } from './xml';

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
  const bytes = files[relsPath];
  if (!bytes) return out;
  for (const rel of childrenNamed(parseXml(strFromU8(bytes)), 'Relationship')) {
    const external = rel.attrs.TargetMode === 'External';
    const target = rel.attrs.Target ?? '';
    out.set(rel.attrs.Id ?? '', { type: rel.attrs.Type ?? '', target: external ? target : resolvePart(dir, target), external });
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
  for (const note of childrenNamed(parseXml(strFromU8(bytes)), element)) {
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
