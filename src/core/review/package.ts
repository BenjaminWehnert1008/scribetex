/**
 * Review files: how comments travel without a server.
 *
 *  - A review copy goes from the author to a reviewer. It holds the PDF, its
 *    SyncTeX data, the text files, the review mirror and the comments so far,
 *    so the reviewer sees the document at once, without compiling anything.
 *  - A comments file goes back. It holds only the review document, which the
 *    author's project merges in.
 *
 * Both are ZIP files with the extension .scribetex and a short README inside
 * for anyone who opens one with another program.
 */
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { tryNormalizePath } from '../paths';
import type { Millis, Path } from '../types';
import { readPerson } from './review-doc';
import type { Person } from './types';

export const REVIEW_EXTENSION = '.scribetex';
const FORMAT = 'scribetex-review';
const MANIFEST = 'scribetex-review.json';

export interface ReviewManifest {
  format: typeof FORMAT;
  version: 1;
  kind: 'review-copy' | 'comments';
  /** Ties the file to the author's project. */
  reviewId: string;
  /** Name of the project. */
  project: string;
  /** Who made the file. */
  from: Person;
  createdAt: Millis;
  /** Review copies only: how the PDF was made. */
  mainFile: Path | null;
  workDir: Path;
  knownPaths: Path[];
}

export interface ReviewCopy {
  manifest: ReviewManifest & { kind: 'review-copy' };
  files: { path: Path; text: string }[];
  mirror: Uint8Array;
  review: Uint8Array;
  pdf: Uint8Array | null;
  synctex: string | null;
}

export interface CommentsFile {
  manifest: ReviewManifest & { kind: 'comments' };
  review: Uint8Array;
}

export class ReviewFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewFileError';
  }
}

export function isReviewFileName(name: string): boolean {
  return name.toLowerCase().endsWith(REVIEW_EXTENSION);
}

function readme(manifest: ReviewManifest, siteUrl: string): string {
  const what =
    manifest.kind === 'review-copy'
      ? `a review copy of "${manifest.project}" from ${manifest.from.name}. Open it to read the document and add comments or suggest changes.`
      : `comments on "${manifest.project}" from ${manifest.from.name}.`;
  return [
    `This file is ${what}`,
    '',
    `It is made for scribeTeX, a LaTeX editor that runs in the browser. Open ${siteUrl}`,
    'and drop this file onto the page, or choose "Open a review file". No account is needed,',
    'and the file stays on your computer.',
    '',
  ].join('\n');
}

export function writeReviewCopy(copy: ReviewCopy, siteUrl: string): Uint8Array {
  const tree: Zippable = {
    [MANIFEST]: strToU8(JSON.stringify(copy.manifest, null, 2)),
    'README.txt': strToU8(readme(copy.manifest, siteUrl)),
    'mirror.ydoc': copy.mirror,
    'review.ydoc': copy.review,
  };
  if (copy.pdf) tree['document.pdf'] = [copy.pdf, { level: 0 }];
  if (copy.synctex !== null) tree['document.synctex'] = strToU8(copy.synctex);
  for (const file of copy.files) tree[`files/${file.path}`] = strToU8(file.text);
  return zipSync(tree, { level: 6 });
}

export function writeComments(file: CommentsFile, siteUrl: string): Uint8Array {
  return zipSync(
    {
      [MANIFEST]: strToU8(JSON.stringify(file.manifest, null, 2)),
      'README.txt': strToU8(readme(file.manifest, siteUrl)),
      'review.ydoc': file.review,
    },
    { level: 6 },
  );
}

/** Limits for opening a file someone else made: a review copy holds text, one PDF and its SyncTeX. */
const MAX_ENTRY_BYTES = 200 * 1024 * 1024;
const MAX_TOTAL_BYTES = 400 * 1024 * 1024;
const MAX_ENTRIES = 5000;

export function readReviewFile(bytes: Uint8Array): ReviewCopy | CommentsFile {
  let entries: Record<string, Uint8Array>;
  try {
    let count = 0;
    let total = 0;
    entries = unzipSync(bytes, {
      filter: (file) => {
        count++;
        total += file.originalSize;
        if (count > MAX_ENTRIES || file.originalSize > MAX_ENTRY_BYTES || total > MAX_TOTAL_BYTES) throw new ReviewFileError('This review file is too large to open.');
        return true;
      },
    });
  } catch (error) {
    if (error instanceof ReviewFileError) throw error;
    throw new ReviewFileError('This is not a review file. It could not be opened.');
  }
  const rawManifest = entries[MANIFEST];
  if (!rawManifest) throw new ReviewFileError('This file has no review in it. Review files are made with "Send for review" or "Send comments back".');
  let parsed: unknown;
  try {
    parsed = JSON.parse(strFromU8(rawManifest));
  } catch {
    throw new ReviewFileError('The review file is damaged.');
  }
  const manifest = readManifest(parsed);
  const review = entries['review.ydoc'];
  if (!review) throw new ReviewFileError('The review file is damaged: it has no comments part.');

  if (manifest.kind === 'comments') return { manifest: { ...manifest, kind: 'comments' }, review };
  const mirror = entries['mirror.ydoc'];
  if (!mirror) throw new ReviewFileError('The review copy is damaged: it has no source part.');
  const files: { path: Path; text: string }[] = [];
  for (const [name, content] of Object.entries(entries)) {
    if (!name.startsWith('files/') || name.endsWith('/')) continue;
    const path = tryNormalizePath(name.slice('files/'.length));
    if (path) files.push({ path, text: strFromU8(content) });
  }
  const synctex = entries['document.synctex'];
  return {
    manifest: { ...manifest, kind: 'review-copy', knownPaths: manifest.knownPaths.length > 0 ? manifest.knownPaths : files.map((file) => file.path) },
    files,
    mirror,
    review,
    pdf: entries['document.pdf'] ?? null,
    synctex: synctex ? strFromU8(synctex) : null,
  };
}

/** Reads a manifest field by field, since the file may come from anyone. */
function readManifest(value: unknown): ReviewManifest {
  if (!value || typeof value !== 'object') throw new ReviewFileError('This is not a review file.');
  const raw = value as Record<string, unknown>;
  if (raw.format !== FORMAT || typeof raw.reviewId !== 'string' || raw.reviewId === '') throw new ReviewFileError('This is not a review file.');
  if (raw.version !== 1) throw new ReviewFileError('This review file was made by a newer version of scribeTeX. Reload the page to get the newest version.');
  if (raw.kind !== 'review-copy' && raw.kind !== 'comments') throw new ReviewFileError('This review file is of an unknown kind.');
  const project = typeof raw.project === 'string' ? raw.project.trim().slice(0, 200) : '';
  const mainFile = typeof raw.mainFile === 'string' ? tryNormalizePath(raw.mainFile) : null;
  return {
    format: FORMAT,
    version: 1,
    kind: raw.kind,
    reviewId: raw.reviewId.slice(0, 200),
    project: project === '' ? 'Untitled' : project,
    from: readPerson(raw.from) ?? { id: 'unknown', name: 'Someone', color: 0 },
    createdAt: typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
    mainFile: mainFile ?? null,
    workDir: typeof raw.workDir === 'string' ? raw.workDir : '',
    knownPaths: Array.isArray(raw.knownPaths) ? raw.knownPaths.filter((path): path is string => typeof path === 'string').slice(0, 20000) : [],
  };
}
