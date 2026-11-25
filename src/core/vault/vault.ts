/**
 * The vault: the editor's own copy of every project, in IndexedDB.
 *
 * This is the source of truth while the app is open. A linked folder on disk is
 * a mirror of it, not the other way round, so the editor keeps working when no
 * folder is linked or when the browser cannot link one.
 *
 * Every mutation is one IndexedDB transaction that covers the file entry, its
 * content blob and the outbox item for the folder mirror, so a crash can never
 * leave a file saved but unmirrored, or an entry pointing at missing content.
 */
import type { IDBPObjectStore, IDBPTransaction, StoreNames } from 'idb';
import { sha256Hex } from '../hash';
import { newId } from '../ids';
import { Emitter } from '../store';
import {
  ancestors,
  basename,
  dirname,
  foldCase,
  isTextContent,
  isWithin,
  normalizePath,
  PathError,
  rebase,
  uniqueName,
} from '../paths';
import type {
  ChangeOrigin,
  FileEntry,
  Hash,
  Millis,
  Path,
  ProjectId,
  ProjectMeta,
  TexEngine,
  VaultChange,
} from '../types';
import { durability, openVaultDB, type OutboxItem, type VaultDB, type VaultSchema } from './db';

export interface WriteOptions {
  origin?: ChangeOrigin;
  /** Skip queuing this change for the linked folder (used when the change came from disk). */
  skipMirror?: boolean;
  /** Overrides the entry's mtime; used when adopting a file from disk. */
  mtime?: Millis;
}

export interface CreateProjectOptions {
  name: string;
  engine?: TexEngine;
  mainFile?: Path | null;
}

const MIRROR_STORES = ['projects', 'entries', 'blobs', 'outbox'] as const;

type MirrorTx = IDBPTransaction<VaultSchema, typeof MIRROR_STORES, 'readwrite'>;
type EntriesStore = IDBPObjectStore<VaultSchema, typeof MIRROR_STORES, 'entries', 'readwrite'>;

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultError';
  }
}

export class Vault {
  readonly changes = new Emitter<VaultChange>();
  readonly #db: VaultDB;
  readonly #now: () => Millis;

  private constructor(db: VaultDB, now: () => Millis) {
    this.#db = db;
    this.#now = now;
  }

  static async open(options: { name?: string; now?: () => Millis } = {}): Promise<Vault> {
    const db = await openVaultDB(options.name);
    return new Vault(db, options.now ?? Date.now);
  }

  close(): void {
    this.#db.close();
  }

  get db(): VaultDB {
    return this.#db;
  }

  // ---------------------------------------------------------------- projects

  async listProjects(): Promise<ProjectMeta[]> {
    const all = await this.#db.getAll('projects');
    return all.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  }

  async getProject(id: ProjectId): Promise<ProjectMeta | undefined> {
    return this.#db.get('projects', id);
  }

  async requireProject(id: ProjectId): Promise<ProjectMeta> {
    const project = await this.getProject(id);
    if (!project) throw new VaultError(`No project ${id}`);
    return project;
  }

  async createProject(options: CreateProjectOptions): Promise<ProjectMeta> {
    const now = this.#now();
    const project: ProjectMeta = {
      id: newId(now),
      name: options.name.trim() || 'Untitled project',
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
      mainFile: options.mainFile ?? null,
      engine: options.engine ?? 'pdflatex',
      bib: 'auto',
      autoCompile: true,
      link: null,
      lastExportAt: null,
      fileCount: 0,
      totalBytes: 0,
    };
    await this.#db.put('projects', project);
    this.changes.emit({ type: 'project', projectId: project.id, project });
    return project;
  }

  async updateProject(id: ProjectId, patch: Partial<Omit<ProjectMeta, 'id'>>): Promise<ProjectMeta> {
    const tx = this.#db.transaction('projects', 'readwrite');
    const current = await tx.store.get(id);
    if (!current) throw new VaultError(`No project ${id}`);
    const next: ProjectMeta = { ...current, ...patch, id };
    await tx.store.put(next);
    await tx.done;
    this.changes.emit({ type: 'project', projectId: id, project: next });
    return next;
  }

  async deleteProject(id: ProjectId): Promise<void> {
    const tx = this.#db.transaction(['projects', 'entries', 'snapshots', 'snapshotFiles', 'outbox', 'handles'], 'readwrite');
    await tx.objectStore('projects').delete(id);
    await deleteByIndex(tx, 'entries', 'projectId', id);
    const snapshotIds = (await tx.objectStore('snapshots').index('projectId').getAllKeys(id)) as string[];
    for (const snapshotId of snapshotIds) {
      await tx.objectStore('snapshots').delete(snapshotId);
      await deleteByIndex(tx, 'snapshotFiles', 'snapshotId', snapshotId);
    }
    await deleteByIndex(tx, 'outbox', 'projectId', id);
    await tx.objectStore('handles').delete(id);
    await tx.done;
    this.changes.emit({ type: 'project', projectId: id, project: null });
  }

  // ------------------------------------------------------------------- reads

  async list(projectId: ProjectId): Promise<FileEntry[]> {
    return this.#db.getAllFromIndex('entries', 'projectId', projectId);
  }

  async stat(projectId: ProjectId, path: Path): Promise<FileEntry | undefined> {
    return this.#db.get('entries', [projectId, path]);
  }

  async exists(projectId: ProjectId, path: Path): Promise<boolean> {
    return (await this.#db.getKey('entries', [projectId, path])) !== undefined;
  }

  async readBytes(projectId: ProjectId, path: Path): Promise<Uint8Array> {
    const entry = await this.stat(projectId, path);
    if (!entry) throw new VaultError(`No file ${path}`);
    if (entry.kind === 'dir') throw new VaultError(`${path} is a folder`);
    return this.readBlob(entry.hash!);
  }

  async readBlob(hash: Hash): Promise<Uint8Array> {
    const blob = await this.#db.get('blobs', hash);
    if (!blob) throw new VaultError(`Missing content ${hash}`);
    return blob.bytes;
  }

  async readText(projectId: ProjectId, path: Path): Promise<string> {
    return new TextDecoder('utf-8').decode(await this.readBytes(projectId, path));
  }

  // ------------------------------------------------------------------ writes

  /** Creates or replaces a file. Parent folders are created as needed. */
  async writeFile(
    projectId: ProjectId,
    rawPath: Path,
    bytes: Uint8Array,
    options: WriteOptions = {},
  ): Promise<FileEntry> {
    const path = normalizePath(rawPath);
    if (path === '') throw new PathError('A file needs a name.');
    const hash = await sha256Hex(bytes);
    const now = options.mtime ?? this.#now();

    const tx = this.transaction(MIRROR_STORES, 'relaxed');
    const entries = tx.objectStore('entries');
    const project = await this.#loadProject(tx, projectId);

    const existing = await entries.get([projectId, path]);
    if (existing?.kind === 'dir') throw new VaultError(`${path} is a folder`);
    await this.#assertNoCaseClash(entries, projectId, path);
    await this.#ensureDirs(tx, projectId, path, now, options);

    const entry: FileEntry = {
      projectId,
      path,
      kind: 'file',
      size: bytes.byteLength,
      mtime: now,
      hash,
      text: isTextContent(path, bytes),
    };
    if (!(await tx.objectStore('blobs').getKey(hash))) {
      await tx.objectStore('blobs').put({ hash, bytes, size: bytes.byteLength, storedAt: now });
    }
    await entries.put(entry);
    await this.#queueMirror(tx, { projectId, op: 'write', path, hash, queuedAt: now, attempts: 0 }, options);
    await this.#touchProject(tx, project, now, {
      files: existing ? 0 : 1,
      bytes: bytes.byteLength - (existing?.size ?? 0),
    });
    await tx.done;

    this.changes.emit({ type: 'write', projectId, path, entry, origin: options.origin ?? 'ui' });
    return entry;
  }

  async writeText(projectId: ProjectId, path: Path, text: string, options: WriteOptions = {}): Promise<FileEntry> {
    return this.writeFile(projectId, path, new TextEncoder().encode(text), options);
  }

  /** Creates a folder (and its parents). Succeeds if it already exists. */
  async mkdir(projectId: ProjectId, rawPath: Path, options: WriteOptions = {}): Promise<FileEntry> {
    const path = normalizePath(rawPath);
    if (path === '') throw new PathError('A folder needs a name.');
    const now = options.mtime ?? this.#now();

    const tx = this.transaction(MIRROR_STORES, 'relaxed');
    const entries = tx.objectStore('entries');
    const project = await this.#loadProject(tx, projectId);
    const existing = await entries.get([projectId, path]);
    if (existing) {
      await tx.done;
      if (existing.kind === 'file') throw new VaultError(`${path} is a file`);
      return existing;
    }
    await this.#assertNoCaseClash(entries, projectId, path);
    await this.#ensureDirs(tx, projectId, path, now, options);
    const entry: FileEntry = { projectId, path, kind: 'dir', size: 0, mtime: now, hash: null, text: false };
    await entries.put(entry);
    await this.#queueMirror(tx, { projectId, op: 'write', path, hash: null, queuedAt: now, attempts: 0 }, options);
    await this.#touchProject(tx, project, now, { files: 0, bytes: 0 });
    await tx.done;

    this.changes.emit({ type: 'mkdir', projectId, path, entry, origin: options.origin ?? 'ui' });
    return entry;
  }

  /** Deletes a file, or a folder with everything inside it. Returns the removed paths. */
  async remove(projectId: ProjectId, rawPath: Path, options: WriteOptions = {}): Promise<Path[]> {
    const path = normalizePath(rawPath);
    if (path === '') throw new VaultError('The project root cannot be deleted.');
    const now = this.#now();

    const tx = this.transaction(MIRROR_STORES, 'relaxed');
    const entries = tx.objectStore('entries');
    const project = await this.#loadProject(tx, projectId);
    const target = await entries.get([projectId, path]);
    if (!target) {
      await tx.done;
      return [];
    }

    const removed: Path[] = [];
    let bytes = 0;
    let files = 0;
    for (const entry of await entries.index('projectId').getAll(projectId)) {
      if (!isWithin(entry.path, path)) continue;
      removed.push(entry.path);
      if (entry.kind === 'file') {
        files += 1;
        bytes += entry.size;
      }
      await entries.delete([projectId, entry.path]);
    }
    // One mirror item for the top-level path: removing it on disk removes the subtree.
    await this.#queueMirror(tx, { projectId, op: 'remove', path, hash: null, queuedAt: now, attempts: 0 }, options);
    await this.#touchProject(tx, project, now, { files: -files, bytes: -bytes });
    await tx.done;

    this.changes.emit({ type: 'remove', projectId, paths: removed, origin: options.origin ?? 'ui' });
    return removed;
  }

  /**
   * Renames or moves a file or folder. Fails if the destination exists, unless
   * it is only a case change of the same path.
   */
  async move(projectId: ProjectId, rawFrom: Path, rawTo: Path, options: WriteOptions = {}): Promise<void> {
    const from = normalizePath(rawFrom);
    const to = normalizePath(rawTo);
    if (from === '' || to === '') throw new VaultError('The project root cannot be moved.');
    if (from === to) return;
    if (isWithin(to, from)) throw new VaultError('A folder cannot be moved into itself.');
    const now = this.#now();

    const tx = this.transaction(MIRROR_STORES, 'relaxed');
    const entries = tx.objectStore('entries');
    const project = await this.#loadProject(tx, projectId);
    const source = await entries.get([projectId, from]);
    if (!source) throw new VaultError(`No file ${from}`);
    const destination = await entries.get([projectId, to]);
    if (destination) throw new VaultError(`${to} already exists.`);
    if (foldCase(from) !== foldCase(to)) await this.#assertNoCaseClash(entries, projectId, to);
    await this.#ensureDirs(tx, projectId, to, now, options);

    const all = await entries.index('projectId').getAll(projectId);
    for (const entry of all) {
      if (!isWithin(entry.path, from)) continue;
      await entries.delete([projectId, entry.path]);
      await entries.put({ ...entry, path: rebase(entry.path, from, to), mtime: now });
    }
    await this.#queueMirror(tx, { projectId, op: 'move', path: from, to, hash: null, queuedAt: now, attempts: 0 }, options);
    await this.#touchProject(tx, project, now, { files: 0, bytes: 0 });
    await tx.done;

    this.changes.emit({ type: 'move', projectId, from, to, origin: options.origin ?? 'ui' });
  }

  /** Renames an entry in place, keeping its parent folder. */
  async rename(projectId: ProjectId, path: Path, newName: string, options: WriteOptions = {}): Promise<Path> {
    const target = normalizePath(dirname(path) === '' ? newName : `${dirname(path)}/${newName}`);
    await this.move(projectId, path, target, options);
    return target;
  }

  /**
   * Writes many files in one transaction (template, ZIP import, snapshot
   * restore). Emits a single `bulk` change.
   */
  async writeMany(
    projectId: ProjectId,
    files: { path: Path; bytes?: Uint8Array; kind?: 'file' | 'dir' }[],
    options: WriteOptions = {},
  ): Promise<void> {
    const now = options.mtime ?? this.#now();
    const prepared = await Promise.all(
      files.map(async (file) => {
        const path = normalizePath(file.path);
        const kind = file.kind ?? 'file';
        const bytes = kind === 'dir' ? undefined : (file.bytes ?? new Uint8Array());
        return { path, kind, bytes, hash: bytes ? await sha256Hex(bytes) : null };
      }),
    );

    const tx = this.transaction(MIRROR_STORES, 'strict');
    const entries = tx.objectStore('entries');
    const project = await this.#loadProject(tx, projectId);
    let files_ = 0;
    let bytes_ = 0;
    for (const item of prepared) {
      if (item.path === '') continue;
      for (const dir of ancestors(item.path)) {
        if (!(await entries.getKey([projectId, dir]))) {
          await entries.put({ projectId, path: dir, kind: 'dir', size: 0, mtime: now, hash: null, text: false });
          await this.#queueMirror(tx, { projectId, op: 'write', path: dir, hash: null, queuedAt: now, attempts: 0 }, options);
        }
      }
      const existing = await entries.get([projectId, item.path]);
      if (item.kind === 'dir') {
        if (existing) continue;
        await entries.put({ projectId, path: item.path, kind: 'dir', size: 0, mtime: now, hash: null, text: false });
      } else {
        const bytes = item.bytes!;
        if (!(await tx.objectStore('blobs').getKey(item.hash!))) {
          await tx.objectStore('blobs').put({ hash: item.hash!, bytes, size: bytes.byteLength, storedAt: now });
        }
        await entries.put({
          projectId,
          path: item.path,
          kind: 'file',
          size: bytes.byteLength,
          mtime: now,
          hash: item.hash,
          text: isTextContent(item.path, bytes),
        });
        if (!existing) files_ += 1;
        bytes_ += bytes.byteLength - (existing?.size ?? 0);
      }
      await this.#queueMirror(tx, { projectId, op: 'write', path: item.path, hash: item.hash, queuedAt: now, attempts: 0 }, options);
    }
    await this.#touchProject(tx, project, now, { files: files_, bytes: bytes_ });
    await tx.done;

    this.changes.emit({ type: 'bulk', projectId, origin: options.origin ?? 'import' });
  }

  /**
   * Replaces the whole project content with `files` in one transaction: used by
   * snapshot restore, where leftover files would otherwise break a compile.
   */
  async replaceAll(
    projectId: ProjectId,
    files: { path: Path; kind: 'file' | 'dir'; hash: Hash | null }[],
    options: WriteOptions = {},
  ): Promise<void> {
    const now = options.mtime ?? this.#now();
    const tx = this.transaction(MIRROR_STORES, 'strict');
    const entries = tx.objectStore('entries');
    const project = await this.#loadProject(tx, projectId);
    const keep = new Set(files.map((file) => file.path));

    for (const entry of await entries.index('projectId').getAll(projectId)) {
      if (keep.has(entry.path)) continue;
      await entries.delete([projectId, entry.path]);
      await this.#queueMirror(tx, { projectId, op: 'remove', path: entry.path, hash: null, queuedAt: now, attempts: 0 }, options);
    }

    let count = 0;
    let bytes = 0;
    for (const file of files) {
      if (file.kind === 'dir') {
        await entries.put({ projectId, path: file.path, kind: 'dir', size: 0, mtime: now, hash: null, text: false });
      } else {
        const blob = await tx.objectStore('blobs').get(file.hash!);
        if (!blob) throw new VaultError(`Missing content ${file.hash}`);
        count += 1;
        bytes += blob.size;
        await entries.put({
          projectId,
          path: file.path,
          kind: 'file',
          size: blob.size,
          mtime: now,
          hash: file.hash,
          text: isTextContent(file.path, blob.bytes),
        });
      }
      await this.#queueMirror(tx, { projectId, op: 'write', path: file.path, hash: file.hash, queuedAt: now, attempts: 0 }, options);
    }
    const next: ProjectMeta = { ...project, updatedAt: now, fileCount: count, totalBytes: bytes };
    await tx.objectStore('projects').put(next);
    await tx.done;

    this.changes.emit({ type: 'bulk', projectId, origin: options.origin ?? 'restore' });
    this.changes.emit({ type: 'project', projectId, project: next });
  }

  /** Stores bytes without attaching them to a path (used before `replaceAll`). */
  async putBlob(bytes: Uint8Array): Promise<Hash> {
    const hash = await sha256Hex(bytes);
    if (!(await this.#db.getKey('blobs', hash))) {
      await this.#db.put('blobs', { hash, bytes, size: bytes.byteLength, storedAt: this.#now() });
    }
    return hash;
  }

  /** A free name for a new file or folder inside `dir`. */
  async suggestName(projectId: ProjectId, dir: Path, desired: string): Promise<string> {
    const siblings = (await this.list(projectId))
      .filter((entry) => dirname(entry.path) === dir)
      .map((entry) => basename(entry.path));
    return uniqueName(siblings, desired);
  }

  // ------------------------------------------------------------------ outbox

  async pendingMirror(projectId: ProjectId): Promise<OutboxItem[]> {
    const items = await this.#db.getAllFromIndex('outbox', 'projectId', projectId);
    return items.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  }

  async countPendingMirror(projectId: ProjectId): Promise<number> {
    return this.#db.countFromIndex('outbox', 'projectId', projectId);
  }

  async clearMirrorItem(seq: number): Promise<void> {
    await this.#db.delete('outbox', seq);
  }

  async markMirrorFailed(seq: number, error: string): Promise<void> {
    const tx = this.#db.transaction('outbox', 'readwrite');
    const item = await tx.store.get(seq);
    if (item) await tx.store.put({ ...item, attempts: item.attempts + 1, lastError: error });
    await tx.done;
  }

  async clearMirrorQueue(projectId: ProjectId): Promise<void> {
    const tx = this.#db.transaction('outbox', 'readwrite');
    for (const key of await tx.store.index('projectId').getAllKeys(projectId)) await tx.store.delete(key);
    await tx.done;
  }

  /** Queues every current file so a freshly linked folder gets the whole project. */
  async queueFullMirror(projectId: ProjectId): Promise<number> {
    const now = this.#now();
    const tx = this.#db.transaction(['entries', 'outbox'], 'readwrite');
    const entries = await tx.objectStore('entries').index('projectId').getAll(projectId);
    const sorted = entries.sort((a, b) => a.path.length - b.path.length);
    for (const entry of sorted) {
      await tx.objectStore('outbox').add({
        projectId,
        op: 'write',
        path: entry.path,
        hash: entry.hash,
        queuedAt: now,
        attempts: 0,
      });
    }
    await tx.done;
    return sorted.length;
  }

  // ----------------------------------------------------------------- handles

  async saveHandle(projectId: ProjectId, handle: FileSystemDirectoryHandle): Promise<void> {
    await this.#db.put('handles', { projectId, handle, savedAt: this.#now() });
  }

  async loadHandle(projectId: ProjectId): Promise<FileSystemDirectoryHandle | null> {
    const row = await this.#db.get('handles', projectId);
    return row?.handle ?? null;
  }

  async forgetHandle(projectId: ProjectId): Promise<void> {
    await this.#db.delete('handles', projectId);
  }

  // ---------------------------------------------------------------- settings

  async getSetting<T>(key: string, fallback: T): Promise<T> {
    const row = await this.#db.get('settings', key);
    return row === undefined ? fallback : (row.value as T);
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    await this.#db.put('settings', { key, value });
  }

  // ----------------------------------------------------------------- private

  /** A transaction with the requested durability, falling back when unsupported. */
  transaction<Names extends readonly StoreNames<VaultSchema>[]>(
    stores: Names,
    mode: 'strict' | 'relaxed',
  ): IDBPTransaction<VaultSchema, Names, 'readwrite'> {
    try {
      return this.#db.transaction(stores, 'readwrite', durability(mode));
    } catch {
      return this.#db.transaction(stores, 'readwrite');
    }
  }

  async #loadProject(
    tx: MirrorTx,
    projectId: ProjectId,
  ): Promise<ProjectMeta> {
    const project = await tx.objectStore('projects').get(projectId);
    if (!project) throw new VaultError(`No project ${projectId}`);
    return project;
  }

  async #touchProject(
    tx: MirrorTx,
    project: ProjectMeta,
    now: Millis,
    delta: { files: number; bytes: number },
  ): Promise<void> {
    await tx.objectStore('projects').put({
      ...project,
      updatedAt: now,
      fileCount: Math.max(0, project.fileCount + delta.files),
      totalBytes: Math.max(0, project.totalBytes + delta.bytes),
    });
  }

  async #ensureDirs(
    tx: MirrorTx,
    projectId: ProjectId,
    path: Path,
    now: Millis,
    options: WriteOptions,
  ): Promise<void> {
    const entries = tx.objectStore('entries');
    for (const dir of ancestors(path)) {
      const existing = await entries.get([projectId, dir]);
      if (existing?.kind === 'file') throw new VaultError(`${dir} is a file, so it cannot hold ${path}.`);
      if (existing) continue;
      await entries.put({ projectId, path: dir, kind: 'dir', size: 0, mtime: now, hash: null, text: false });
      await this.#queueMirror(tx, { projectId, op: 'write', path: dir, hash: null, queuedAt: now, attempts: 0 }, options);
    }
  }

  /**
   * Refuses two entries whose paths differ only in case: a linked folder on
   * macOS or Windows could not hold both, and the editor must never hold files
   * it cannot mirror.
   */
  async #assertNoCaseClash(
    entries: EntriesStore,
    projectId: ProjectId,
    path: Path,
  ): Promise<void> {
    const folded = foldCase(path);
    for (const key of await entries.index('projectId').getAllKeys(projectId)) {
      const other = key[1];
      if (other !== path && foldCase(other) === folded) {
        throw new VaultError(`${other} already exists and differs only in upper and lower case.`);
      }
    }
  }

  async #queueMirror(
    tx: MirrorTx,
    item: OutboxItem,
    options: WriteOptions,
  ): Promise<void> {
    if (options.skipMirror) return;
    await tx.objectStore('outbox').add(item);
  }
}

async function deleteByIndex<Name extends 'entries' | 'snapshotFiles' | 'outbox'>(
  tx: IDBPTransaction<VaultSchema, readonly StoreNames<VaultSchema>[], 'readwrite'>,
  store: Name,
  index: 'projectId' | 'snapshotId',
  key: string,
): Promise<void> {
  const objectStore = tx.objectStore(store);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const keys = await (objectStore.index as any)(index).getAllKeys(key);
  for (const entryKey of keys) await (objectStore as { delete(k: unknown): Promise<void> }).delete(entryKey);
}
