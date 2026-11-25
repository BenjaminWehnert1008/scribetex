/**
 * Path helpers for project-relative POSIX paths (see `Path` in types.ts).
 * Pure functions, no I/O.
 */
import type { Path } from './types';

export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathError';
  }
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f<>:"|?*\\/]/;
const MAX_NAME_BYTES = 255;

const encoder = new TextEncoder();

/**
 * Checks a single file or folder name. Returns a human-readable reason when the
 * name must be rejected, or `null` when it is fine. The rules are the
 * intersection of what Windows, macOS and Linux accept, so a project can always
 * be written to a linked folder on any of them.
 */
export function validateName(name: string): string | null {
  if (name.length === 0) return 'The name is empty.';
  if (name === '.' || name === '..') return 'This name is reserved.';
  if (FORBIDDEN_CHARS.test(name)) return 'The name contains a character that is not allowed: \\ / : * ? " < > |';
  if (/[. ]$/.test(name)) return 'The name must not end with a dot or a space.';
  if (/^ /.test(name)) return 'The name must not start with a space.';
  if (WINDOWS_RESERVED.test(name)) return 'This name is reserved on Windows.';
  if (encoder.encode(name).length > MAX_NAME_BYTES) return 'The name is too long.';
  return null;
}

/**
 * Normalizes user or disk input into a `Path`. Accepts backslashes, leading
 * "./" and repeated slashes. Throws `PathError` for paths that escape the
 * project root or contain invalid names.
 */
export function normalizePath(input: string): Path {
  const segments: string[] = [];
  for (const raw of input.normalize('NFC').replace(/\\/g, '/').split('/')) {
    if (raw === '' || raw === '.') continue;
    if (raw === '..') throw new PathError(`Path escapes the project: ${input}`);
    const problem = validateName(raw);
    if (problem) throw new PathError(`${problem} (${raw})`);
    segments.push(raw);
  }
  return segments.join('/');
}

/** Like `normalizePath`, but returns `null` instead of throwing. */
export function tryNormalizePath(input: string): Path | null {
  try {
    return normalizePath(input);
  } catch {
    return null;
  }
}

export function joinPath(...parts: string[]): Path {
  return normalizePath(parts.filter((p) => p !== '').join('/'));
}

/** Parent directory; the empty string for entries at the project root. */
export function dirname(path: Path): Path {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

export function basename(path: Path): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/** Lowercase extension including the dot, or '' when there is none. */
export function extname(path: Path): string {
  const name = basename(path);
  const i = name.lastIndexOf('.');
  return i <= 0 ? '' : name.slice(i).toLowerCase();
}

/** File name without its last extension. */
export function stem(path: Path): string {
  const name = basename(path);
  const i = name.lastIndexOf('.');
  return i <= 0 ? name : name.slice(0, i);
}

/** All ancestor directories, outermost first: 'a/b/c.tex' gives ['a', 'a/b']. */
export function ancestors(path: Path): Path[] {
  const out: Path[] = [];
  let i = path.indexOf('/');
  while (i !== -1) {
    out.push(path.slice(0, i));
    i = path.indexOf('/', i + 1);
  }
  return out;
}

/** True when `path` is `dir` itself or lies inside it. The root ('') contains everything. */
export function isWithin(path: Path, dir: Path): boolean {
  return dir === '' || path === dir || path.startsWith(dir + '/');
}

/** Moves `path` from under `fromDir` to under `toDir` (used for folder renames). */
export function rebase(path: Path, fromDir: Path, toDir: Path): Path {
  if (!isWithin(path, fromDir)) throw new PathError(`${path} is not inside ${fromDir}`);
  const rest = path === fromDir ? '' : fromDir === '' ? path : path.slice(fromDir.length + 1);
  return joinPath(toDir, rest);
}

/**
 * Key for case-insensitive comparisons. macOS and Windows folders usually
 * cannot hold "Figure.png" next to "figure.png", so the vault refuses such
 * siblings and uses this key to detect them.
 */
export function foldCase(path: Path): string {
  return path.normalize('NFC').toLowerCase();
}

/**
 * Returns `desired`, or a variant such as "plot (2).png" that does not collide
 * (case-insensitively) with any name in `taken`.
 */
export function uniqueName(taken: Iterable<string>, desired: string): string {
  const used = new Set<string>();
  for (const name of taken) used.add(foldCase(name));
  if (!used.has(foldCase(desired))) return desired;
  const dot = desired.lastIndexOf('.');
  const base = dot <= 0 ? desired : desired.slice(0, dot);
  const ext = dot <= 0 ? '' : desired.slice(dot);
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!used.has(foldCase(candidate))) return candidate;
  }
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Sort order for file trees: folders first, then natural, case-insensitive order by name. */
export function compareTreeOrder(
  a: { path: Path; kind: 'file' | 'dir' },
  b: { path: Path; kind: 'file' | 'dir' },
): number {
  const as = a.path.split('/');
  const bs = b.path.split('/');
  const shared = Math.min(as.length, bs.length);
  for (let i = 0; i < shared; i++) {
    const an = as[i]!;
    const bn = bs[i]!;
    if (an === bn) continue;
    const aIsDir = i < as.length - 1 || a.kind === 'dir';
    const bIsDir = i < bs.length - 1 || b.kind === 'dir';
    if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
    return collator.compare(an, bn) || (an < bn ? -1 : 1);
  }
  return as.length - bs.length;
}

/** Extensions the editor treats as text without looking at the bytes. */
const TEXT_EXTENSIONS = new Set([
  '.tex', '.ltx', '.latex', '.bib', '.bst', '.sty', '.cls', '.clo', '.def', '.cfg', '.fd', '.ldf', '.lco',
  '.bbx', '.cbx', '.lbx', '.dbx', '.ist', '.gst', '.dtx', '.ins', '.tikz', '.pgf', '.txt', '.md', '.csv',
  '.tsv', '.dat', '.json', '.yml', '.yaml', '.toml', '.xml', '.svg', '.gitignore', '.latexmkrc', '.bbl',
  '.aux', '.log', '.toc', '.lof', '.lot', '.out', '.idx', '.ind', '.glo', '.gls', '.nav', '.snm', '.r',
  '.py', '.m', '.sh', '.asy', '.mp', '.lua',
]);

/** Extensions that are always binary. Anything else is decided by sniffing the bytes. */
const BINARY_EXTENSIONS = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tif', '.tiff', '.eps', '.ps', '.ico',
  '.ttf', '.otf', '.woff', '.woff2', '.pfb', '.tfm', '.vf', '.zip', '.gz', '.xz', '.7z', '.docx',
  '.xlsx', '.pptx', '.synctex',
]);

export type ContentGuess = 'text' | 'binary' | 'unknown';

export function guessContentKind(path: Path): ContentGuess {
  const ext = extname(path) || basename(path).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  if (BINARY_EXTENSIONS.has(ext)) return 'binary';
  return 'unknown';
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Decides whether bytes can be opened in the text editor: valid UTF-8 and no
 * NUL byte. Known binary extensions are never text.
 */
export function isTextContent(path: Path, bytes: Uint8Array): boolean {
  if (guessContentKind(path) === 'binary') return false;
  if (bytes.includes(0)) return false;
  try {
    strictUtf8.decode(bytes);
    return true;
  } catch {
    return false;
  }
}
