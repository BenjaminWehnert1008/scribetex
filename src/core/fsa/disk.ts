/**
 * Reading and writing a folder on the user's disk through the File System
 * Access API. Only the handful of methods used here is described, so the same
 * code runs against the browser's handles and against the in-memory folder
 * the tests use.
 */
import { basename, dirname } from '../paths';
import type { EntryKind, Path } from '../types';
import { ignoreReason } from './plan';

export interface DiskFile {
  readonly size: number;
  readonly lastModified: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface DiskWritable {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface FileHandle {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<DiskFile>;
  createWritable(): Promise<DiskWritable>;
}

export type Permission = 'granted' | 'denied' | 'prompt';

export interface DirHandle {
  readonly kind: 'directory';
  readonly name: string;
  entries(): AsyncIterable<[string, DirHandle | FileHandle]>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  queryPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<Permission>;
  requestPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<Permission>;
  isSameEntry?(other: DirHandle): Promise<boolean>;
}

export interface DiskEntry {
  kind: EntryKind;
  size: number;
  mtime: number;
  /** Present for files; reading is deferred until the content is needed. */
  file?: DiskFile;
}

export interface ScanResult {
  entries: Map<Path, DiskEntry>;
  /** Entries that exist on disk but are not part of the project, by reason. */
  skipped: { path: Path; reason: 'name' | 'size' }[];
}

export const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_ENTRIES = 20_000;

export class DiskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiskError';
  }
}

/** Whether the folder may be read and written right now, without asking. */
export async function permissionOf(root: DirHandle): Promise<Permission> {
  if (!root.queryPermission) return 'granted';
  try {
    return await root.queryPermission({ mode: 'readwrite' });
  } catch {
    return 'denied';
  }
}

/** Asks the user for access. Must be called from a click or key press. */
export async function requestPermission(root: DirHandle): Promise<Permission> {
  if (!root.requestPermission) return 'granted';
  try {
    return await root.requestPermission({ mode: 'readwrite' });
  } catch {
    return 'denied';
  }
}

/**
 * Lists the folder. `known` tells whether the project already has a path, and
 * `extraIgnore` names files the app itself writes there (the compiled PDF).
 */
export async function scanFolder(root: DirHandle, known: (path: Path) => boolean, extraIgnore: (path: Path) => boolean = () => false): Promise<ScanResult> {
  const entries = new Map<Path, DiskEntry>();
  const skipped: ScanResult['skipped'] = [];

  const walk = async (dir: DirHandle, prefix: Path): Promise<void> => {
    for await (const [name, handle] of dir.entries()) {
      const path = prefix === '' ? name.normalize('NFC') : `${prefix}/${name.normalize('NFC')}`;
      const kind: EntryKind = handle.kind === 'directory' ? 'dir' : 'file';
      if (extraIgnore(path)) continue;
      const reason = ignoreReason(path, kind, known(path));
      if (reason === 'name') skipped.push({ path, reason });
      if (reason !== null) continue;
      if (entries.size >= MAX_ENTRIES) throw new DiskError(`The folder holds more than ${MAX_ENTRIES} files. Choose the folder of one project.`);
      if (handle.kind === 'directory') {
        entries.set(path, { kind: 'dir', size: 0, mtime: 0 });
        await walk(handle, path);
      } else {
        const file = await handle.getFile();
        if (file.size > MAX_FILE_BYTES) {
          skipped.push({ path, reason: 'size' });
          continue;
        }
        entries.set(path, { kind: 'file', size: file.size, mtime: file.lastModified, file });
      }
    }
  };
  await walk(root, '');
  return { entries, skipped };
}

async function directoryAt(root: DirHandle, path: Path, create: boolean): Promise<DirHandle> {
  let dir = root;
  if (path === '') return dir;
  for (const segment of path.split('/')) dir = await dir.getDirectoryHandle(segment, { create });
  return dir;
}

export async function makeDiskFolder(root: DirHandle, path: Path): Promise<void> {
  await directoryAt(root, path, true);
}

/** Writes a file, creating its folders, and returns what the disk now reports for it. */
export async function writeDiskFile(root: DirHandle, path: Path, bytes: Uint8Array): Promise<{ size: number; mtime: number }> {
  const dir = await directoryAt(root, dirname(path), true);
  const handle = await dir.getFileHandle(basename(path), { create: true });
  // The browser writes to a temporary file and swaps it in on close, so a
  // crash in between leaves the old content, never half a file.
  const writable = await handle.createWritable();
  await writable.write(bytes);
  await writable.close();
  const file = await handle.getFile();
  return { size: file.size, mtime: file.lastModified };
}

export async function readDiskFile(root: DirHandle, path: Path): Promise<{ bytes: Uint8Array; size: number; mtime: number }> {
  const dir = await directoryAt(root, dirname(path), false);
  const file = await (await dir.getFileHandle(basename(path))).getFile();
  return { bytes: new Uint8Array(await file.arrayBuffer()), size: file.size, mtime: file.lastModified };
}

/** Removes a file or a whole folder. Something that is already gone is not an error. */
export async function removeDiskEntry(root: DirHandle, path: Path): Promise<void> {
  try {
    const dir = await directoryAt(root, dirname(path), false);
    await dir.removeEntry(basename(path), { recursive: true });
  } catch (error) {
    if (error instanceof Error && error.name === 'NotFoundError') return;
    throw error;
  }
}

/** True when the folder has nothing in it that would become part of a project. */
export async function isFolderEmpty(root: DirHandle): Promise<boolean> {
  const { entries } = await scanFolder(root, () => false);
  return entries.size === 0;
}
