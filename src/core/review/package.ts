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

export function readReviewFile(bytes: Uint8Array): ReviewCopy | CommentsFile {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new ReviewFileError('This is not a review file. It could not be opened.');
  }
  const rawManifest = entries[MANIFEST];
  if (!rawManifest) throw new ReviewFileError('This file has no review in it. Review files are made with "Send for review" or "Send comments back".');
  let manifest: ReviewManifest;
  try {
    manifest = JSON.parse(strFromU8(rawManifest)) as ReviewManifest;
  } catch {
    throw new ReviewFileError('The review file is damaged.');
  }
  if (manifest.format !== FORMAT || typeof manifest.reviewId !== 'string') throw new ReviewFileError('This is not a review file.');
  if (manifest.version !== 1) throw new ReviewFileError('This review file was made by a newer version of scribeTeX. Reload the page to get the newest version.');
  const review = entries['review.ydoc'];
  if (!review) throw new ReviewFileError('The review file is damaged: it has no comments part.');

  if (manifest.kind === 'comments') return { manifest: manifest as CommentsFile['manifest'], review };
  if (manifest.kind !== 'review-copy') throw new ReviewFileError('This review file is of an unknown kind.');
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
    manifest: {
      ...manifest,
      kind: 'review-copy',
      knownPaths: Array.isArray(manifest.knownPaths) ? manifest.knownPaths : files.map((file) => file.path),
      workDir: typeof manifest.workDir === 'string' ? manifest.workDir : '',
      mainFile: manifest.mainFile ?? null,
    },
    files,
    mirror,
    review,
    pdf: entries['document.pdf'] ?? null,
    synctex: synctex ? strFromU8(synctex) : null,
  };
}
