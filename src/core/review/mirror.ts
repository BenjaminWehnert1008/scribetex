/**
 * The review mirror: a copy of the project's text files as a Yjs document.
 *
 * Comments and suggestions point into the source with Yjs relative positions,
 * which name characters rather than offsets. A comment on "the results" keeps
 * pointing at those words while text is typed, deleted or pasted around them,
 * on this computer and in a reviewer's copy of the project alike, because the
 * reviewer gets this very document with the review copy.
 *
 * The vault stays the source of truth for the files. The mirror follows it:
 * the editor reports its exact changes, and anything else that rewrote a file
 * (the linked folder, a restore) is diffed in. Deleted files keep their text
 * here, so comments on them can still say where they were.
 *
 * Files are keyed by an id, not by their path, so a rename keeps the comments.
 */
import * as Y from 'yjs';
import type { Path } from '../types';
import { diffText, type TextChange } from './text-diff';

export interface Anchor {
  fileId: string;
  /** Encoded Yjs relative positions of the start and the end of the range. */
  start: Uint8Array;
  end: Uint8Array;
}

export interface SourceRange {
  fileId: string;
  path: Path;
  from: number;
  to: number;
  /** The file is no longer in the project. */
  deleted: boolean;
}

/** Transaction origin of changes made on this computer; anything else came in from a file. */
export const LOCAL = 'local';

type FileMap = Y.Map<unknown>;

let idCounter = 0;
function newFileId(): string {
  idCounter = (idCounter + 1) % 1_000_000;
  const random = crypto.getRandomValues(new Uint32Array(2));
  return `f${Date.now().toString(36)}${random[0]!.toString(36)}${random[1]!.toString(36)}${idCounter.toString(36)}`;
}

export class SourceMirror {
  readonly doc: Y.Doc;
  readonly #files: Y.Map<FileMap>;
  #index: Map<Path, string> | null = null;

  constructor(doc: Y.Doc = new Y.Doc()) {
    this.doc = doc;
    this.#files = doc.getMap<FileMap>('files');
    doc.on('update', () => {
      this.#index = null;
    });
  }

  /** Paths of the files that are in the project. */
  paths(): Path[] {
    return [...this.#byPath().keys()].sort();
  }

  fileId(path: Path): string | null {
    return this.#byPath().get(path) ?? null;
  }

  pathOf(fileId: string): Path | null {
    const file = this.#files.get(fileId);
    return file ? (file.get('path') as Path) : null;
  }

  isDeleted(fileId: string): boolean {
    return this.#files.get(fileId)?.get('deleted') === true;
  }

  /** The text of a file in the project, or null. */
  text(path: Path): string | null {
    const id = this.fileId(path);
    return id ? this.#text(id)!.toString() : null;
  }

  textOf(fileId: string): string | null {
    return this.#text(fileId)?.toString() ?? null;
  }

  /** Makes the mirror hold `text` for `path`, creating the file when it is new. */
  setText(path: Path, text: string): void {
    this.doc.transact(() => {
      const id = this.fileId(path) ?? this.#revive(path) ?? this.#create(path, '');
      const ytext = this.#text(id)!;
      const change = diffText(ytext.toString(), text);
      if (change) applyTo(ytext, [change]);
    }, LOCAL);
  }

  /**
   * Applies the editor's own changes, given in positions of the text before
   * them, in ascending order. `after` is the text they lead to; when the mirror
   * turns out not to have held the text they were made on, it is used instead.
   */
  applyChanges(path: Path, changes: readonly TextChange[], after: string): void {
    const id = this.fileId(path);
    const ytext = id ? this.#text(id)! : null;
    const removed = changes.reduce((sum, change) => sum + change.to - change.from, 0);
    const inserted = changes.reduce((sum, change) => sum + change.insert.length, 0);
    if (!ytext || ytext.length !== after.length - inserted + removed) {
      this.setText(path, after);
      return;
    }
    this.doc.transact(() => applyTo(ytext, changes), LOCAL);
    if (ytext.length !== after.length) this.setText(path, after);
  }

  /** Follows a rename or a move of a file or a folder. */
  rename(from: Path, to: Path): void {
    this.doc.transact(() => {
      for (const file of this.#files.values()) {
        if (file.get('deleted') === true) continue;
        const path = file.get('path') as Path;
        if (path === from) file.set('path', to);
        else if (path.startsWith(`${from}/`)) file.set('path', to + path.slice(from.length));
      }
      this.#index = null;
    }, LOCAL);
  }

  /** Marks files, or everything inside folders, as gone. Their text is kept. */
  remove(paths: readonly Path[]): void {
    if (paths.length === 0) return;
    this.doc.transact(() => {
      for (const file of this.#files.values()) {
        if (file.get('deleted') === true) continue;
        const path = file.get('path') as Path;
        if (paths.some((gone) => path === gone || path.startsWith(`${gone}/`))) file.set('deleted', true);
      }
      this.#index = null;
    }, LOCAL);
  }

  /**
   * Brings the mirror in line with the complete list of text files. A file that
   * disappeared while one with exactly its text appeared is taken as renamed.
   */
  reconcile(files: readonly { path: Path; text: string }[]): void {
    this.doc.transact(() => {
      const wanted = new Map(files.map((file) => [file.path, file.text]));
      const live = this.#byPath();
      const missing = [...live].filter(([path]) => !wanted.has(path)).map(([, id]) => id);
      for (const [path, text] of wanted) {
        if (live.has(path)) continue;
        const renamed = missing.find((id) => this.#text(id)!.toString() === text);
        if (renamed !== undefined) {
          this.#files.get(renamed)!.set('path', path);
          missing.splice(missing.indexOf(renamed), 1);
        }
      }
      for (const id of missing) this.#files.get(id)!.set('deleted', true);
      this.#index = null;
      for (const [path, text] of wanted) this.setText(path, text);
    }, LOCAL);
  }

  /** A range of a file, as positions that survive later edits. */
  anchor(path: Path, from: number, to: number): Anchor | null {
    const id = this.fileId(path);
    const ytext = id ? this.#text(id) : null;
    if (!id || !ytext) return null;
    const start = Math.max(0, Math.min(from, ytext.length));
    const end = Math.max(start, Math.min(to, ytext.length));
    const startPos = Y.createRelativePositionFromTypeIndex(ytext, start, 0);
    // The end sticks to the last character of the range, so text typed right after it stays outside.
    const endPos = end > start ? Y.createRelativePositionFromTypeIndex(ytext, end, -1) : startPos;
    return { fileId: id, start: Y.encodeRelativePosition(startPos), end: Y.encodeRelativePosition(endPos) };
  }

  /** Where an anchored range is now, or null when the mirror does not know it. */
  resolve(anchor: Anchor): SourceRange | null {
    const file = this.#files.get(anchor.fileId);
    const ytext = this.#text(anchor.fileId);
    if (!file || !ytext) return null;
    const start = this.#absolute(anchor.start, ytext);
    const end = this.#absolute(anchor.end, ytext);
    if (start === null || end === null) return null;
    return {
      fileId: anchor.fileId,
      path: file.get('path') as Path,
      from: start,
      to: Math.max(start, end),
      deleted: file.get('deleted') === true,
    };
  }

  encode(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }

  #absolute(encoded: Uint8Array, ytext: Y.Text): number | null {
    try {
      const position = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(encoded), this.doc);
      if (!position || position.type !== ytext) return null;
      return position.index;
    } catch {
      return null;
    }
  }

  #text(id: string): Y.Text | null {
    const value = this.#files.get(id)?.get('text');
    return value instanceof Y.Text ? value : null;
  }

  #create(path: Path, text: string): string {
    const id = newFileId();
    const file = new Y.Map<unknown>();
    file.set('path', path);
    file.set('text', new Y.Text(text));
    file.set('deleted', false);
    this.#files.set(id, file);
    this.#index = null;
    return id;
  }

  /** A deleted file that comes back at its old path (a restore, an undo) gets its old id back. */
  #revive(path: Path): string | null {
    let found: string | null = null;
    for (const [id, file] of this.#files) {
      if (file.get('deleted') === true && file.get('path') === path && (found === null || id < found)) found = id;
    }
    if (found !== null) {
      this.#files.get(found)!.set('deleted', false);
      this.#index = null;
    }
    return found;
  }

  #byPath(): Map<Path, string> {
    if (this.#index) return this.#index;
    const index = new Map<Path, string>();
    for (const [id, file] of this.#files) {
      if (file.get('deleted') === true) continue;
      const path = file.get('path') as Path;
      const other = index.get(path);
      // Two live files at one path cannot be made here; should a merged copy hold them, one rule picks the same one everywhere.
      if (other === undefined || id < other) index.set(path, id);
    }
    this.#index = index;
    return index;
  }
}

/** Applies changes in positions of the text before them; the last one first, so the earlier positions stay valid. */
function applyTo(ytext: Y.Text, changes: readonly TextChange[]): void {
  for (let index = changes.length - 1; index >= 0; index--) {
    const change = changes[index]!;
    if (change.to > change.from) ytext.delete(change.from, change.to - change.from);
    if (change.insert) ytext.insert(change.from, change.insert);
  }
}
