/**
 * Keeps the review documents of every project in IndexedDB, in a database of
 * their own next to the vault.
 *
 * A Yjs document is stored as the list of its updates: typing appends small
 * records instead of rewriting the whole document. Loading merges them, and
 * when many have piled up they are replaced by their merge.
 */
import { type DBSchema, type IDBPDatabase, openDB } from 'idb';
import * as Y from 'yjs';
import type { Path, ProjectId } from '../types';

/** What a reviewer's copy of a project brought along besides the files. */
export interface ReviewCopyAssets {
  projectId: ProjectId;
  pdf: Uint8Array | null;
  synctex: string | null;
  /** How to read the file names in `synctex`. */
  knownPaths: Path[];
  workDir: Path;
  mainFile: Path | null;
}

interface ReviewSchema extends DBSchema {
  updates: {
    key: number;
    value: { seq?: number; key: string; update: Uint8Array };
    indexes: { key: string };
  };
  copies: {
    key: ProjectId;
    value: ReviewCopyAssets;
  };
}

export type DocName = 'mirror' | 'review';

const COMPACT_AFTER = 64;

export class ReviewStorage {
  readonly #db: IDBPDatabase<ReviewSchema>;

  private constructor(db: IDBPDatabase<ReviewSchema>) {
    this.#db = db;
  }

  static async open(name = 'scribetex-review'): Promise<ReviewStorage> {
    const db = await openDB<ReviewSchema>(name, 1, {
      upgrade(database) {
        const updates = database.createObjectStore('updates', { keyPath: 'seq', autoIncrement: true });
        updates.createIndex('key', 'key');
        database.createObjectStore('copies', { keyPath: 'projectId' });
      },
    });
    return new ReviewStorage(db);
  }

  /** The stored document, merged into one update, or null when nothing was stored. */
  async load(projectId: ProjectId, doc: DocName): Promise<Uint8Array | null> {
    const key = docKey(projectId, doc);
    const rows = await this.#db.getAllFromIndex('updates', 'key', key);
    if (rows.length === 0) return null;
    rows.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    const merged = rows.length === 1 ? rows[0]!.update : Y.mergeUpdates(rows.map((row) => row.update));
    if (rows.length > COMPACT_AFTER) await this.#replaceRows(key, rows.map((row) => row.seq!), merged);
    return merged;
  }

  async append(projectId: ProjectId, doc: DocName, update: Uint8Array): Promise<void> {
    await this.#db.add('updates', { key: docKey(projectId, doc), update });
  }

  /** Replaces everything stored for the document with one update. */
  async replace(projectId: ProjectId, doc: DocName, update: Uint8Array): Promise<void> {
    const key = docKey(projectId, doc);
    const seqs = (await this.#db.getAllKeysFromIndex('updates', 'key', key)) as number[];
    await this.#replaceRows(key, seqs, update);
  }

  async has(projectId: ProjectId, doc: DocName): Promise<boolean> {
    return (await this.#db.countFromIndex('updates', 'key', docKey(projectId, doc))) > 0;
  }

  async putCopy(assets: ReviewCopyAssets): Promise<void> {
    await this.#db.put('copies', assets);
  }

  async getCopy(projectId: ProjectId): Promise<ReviewCopyAssets | null> {
    return (await this.#db.get('copies', projectId)) ?? null;
  }

  async deleteProject(projectId: ProjectId): Promise<void> {
    const tx = this.#db.transaction(['updates', 'copies'], 'readwrite');
    for (const doc of ['mirror', 'review'] as const) {
      const index = tx.objectStore('updates').index('key');
      for (let cursor = await index.openCursor(docKey(projectId, doc)); cursor; cursor = await cursor.continue()) await cursor.delete();
    }
    await tx.objectStore('copies').delete(projectId);
    await tx.done;
  }

  close(): void {
    this.#db.close();
  }

  async #replaceRows(key: string, seqs: number[], update: Uint8Array): Promise<void> {
    const tx = this.#db.transaction('updates', 'readwrite');
    for (const seq of seqs) await tx.store.delete(seq);
    await tx.store.add({ key, update });
    await tx.done;
  }
}

function docKey(projectId: ProjectId, doc: DocName): string {
  return `${projectId}/${doc}`;
}

/**
 * Writes a document's updates to storage as they happen. `delayMs` gathers
 * the updates of a burst of typing into one record.
 */
export class DocPersistence {
  readonly #storage: ReviewStorage;
  readonly #projectId: ProjectId;
  readonly #name: DocName;
  readonly #doc: Y.Doc;
  readonly #delayMs: number;
  readonly #retryMs: number;
  readonly #off: () => void;
  #pending: Uint8Array[] = [];
  #timer: ReturnType<typeof setTimeout> | null = null;
  #writing: Promise<void> = Promise.resolve();
  #disposed = false;
  /** False in a tab that only reads the project, so two tabs never both write a document. */
  enabled = true;

  constructor(storage: ReviewStorage, projectId: ProjectId, name: DocName, doc: Y.Doc, options: { delayMs?: number; retryMs?: number } = {}) {
    this.#storage = storage;
    this.#projectId = projectId;
    this.#name = name;
    this.#doc = doc;
    this.#delayMs = options.delayMs ?? 0;
    this.#retryMs = options.retryMs ?? 2000;
    const onUpdate = (update: Uint8Array, origin: unknown): void => {
      if (origin === LOAD || !this.enabled) return;
      this.#pending.push(update);
      if (this.#delayMs === 0) void this.flush();
      else this.#timer ??= setTimeout(() => void this.flush(), this.#delayMs);
    };
    doc.on('update', onUpdate);
    this.#off = () => doc.off('update', onUpdate);
  }

  /** Applies what storage holds to the document. */
  async load(): Promise<boolean> {
    const stored = await this.#storage.load(this.#projectId, this.#name);
    if (stored) Y.applyUpdate(this.#doc, stored, LOAD);
    return stored !== null;
  }

  flush(): Promise<void> {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    if (this.#pending.length === 0) return this.#writing;
    const batch = this.#pending.length === 1 ? this.#pending[0]! : Y.mergeUpdates(this.#pending);
    this.#pending = [];
    this.#writing = this.#writing
      .then(() => this.#storage.append(this.#projectId, this.#name, batch))
      .catch((error: unknown) => {
        // Nothing is dropped: the batch goes along with the next write, and later
        // updates, which may build on it, never end up stored without it.
        console.warn('Comments could not be stored; trying again.', error);
        this.#pending.unshift(batch);
        if (!this.#disposed) this.#timer ??= setTimeout(() => void this.flush(), this.#retryMs);
      });
    return this.#writing;
  }

  /** Stores the whole document as one record, replacing what was there. Not in a tab that only reads. */
  async rewrite(): Promise<void> {
    if (!this.enabled) return;
    this.#pending = [];
    await this.#writing;
    await this.#storage.replace(this.#projectId, this.#name, Y.encodeStateAsUpdate(this.#doc));
  }

  /** Adds the whole document to what is stored, also in a tab that only reads. */
  async storeAll(): Promise<void> {
    await this.#writing;
    await this.#storage.append(this.#projectId, this.#name, Y.encodeStateAsUpdate(this.#doc));
  }

  async dispose(): Promise<void> {
    await this.flush();
    this.#disposed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#off();
  }
}

/** Transaction origin of updates read from storage, which must not be written back. */
export const LOAD = 'load';
