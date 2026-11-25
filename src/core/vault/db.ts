/**
 * IndexedDB schema for the vault.
 *
 * Design notes
 * - File contents are content-addressed: `blobs` is keyed by the SHA-256 of the
 *   bytes. Two files with the same content share one blob, which makes
 *   snapshots almost free and lets the folder sync compare hashes instead of
 *   bytes. Unreferenced blobs are removed by a sweep (see `gc.ts`), not by
 *   reference counting, because a counter that drifts after a crash would
 *   delete live data.
 * - `entries` holds one record per file and per directory. Directories are
 *   explicit so that empty folders survive a reload, which is the feature this
 *   editor exists for.
 * - `outbox` holds work that must still reach the linked folder on disk. It is
 *   written in the same transaction as the file itself, so a crash can never
 *   lose the fact that a file still has to be mirrored.
 */
import { type DBSchema, type IDBPDatabase, openDB } from 'idb';
import type { FileEntry, Hash, Millis, Path, ProjectId, ProjectMeta, SnapshotFile, SnapshotMeta } from '../types';

export const DB_NAME = 'latex-editor';
export const DB_VERSION = 1;

/** One pending mirror operation for the linked folder. */
export interface OutboxItem {
  seq?: number;
  projectId: ProjectId;
  /** `write` also covers creating a directory (when `hash` is null). */
  op: 'write' | 'remove' | 'move';
  path: Path;
  /** Target path for `move`. */
  to?: Path;
  /** Content to write; null for directories and for removals. */
  hash: Hash | null;
  queuedAt: Millis;
  /** Number of failed attempts, used for backoff and for reporting. */
  attempts: number;
  lastError?: string;
}

export interface VaultSchema extends DBSchema {
  projects: {
    key: ProjectId;
    value: ProjectMeta;
    indexes: { lastOpenedAt: Millis };
  };
  entries: {
    key: [ProjectId, Path];
    value: FileEntry;
    indexes: { projectId: ProjectId; hash: Hash };
  };
  blobs: {
    key: Hash;
    value: { hash: Hash; bytes: Uint8Array; size: number; storedAt: Millis };
  };
  snapshots: {
    key: string;
    value: SnapshotMeta;
    indexes: { projectId: ProjectId; projectCreatedAt: [ProjectId, Millis] };
  };
  snapshotFiles: {
    key: [string, Path];
    value: SnapshotFile & { snapshotId: string };
    indexes: { snapshotId: string };
  };
  outbox: {
    key: number;
    value: OutboxItem;
    indexes: { projectId: ProjectId };
  };
  /** Directory handles for linked folders. Handles are structured-clonable. */
  handles: {
    key: ProjectId;
    value: { projectId: ProjectId; handle: FileSystemDirectoryHandle; savedAt: Millis };
  };
  settings: {
    key: string;
    value: { key: string; value: unknown };
  };
}

export type VaultDB = IDBPDatabase<VaultSchema>;

export function openVaultDB(name: string = DB_NAME): Promise<VaultDB> {
  return openDB<VaultSchema>(name, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        const projects = db.createObjectStore('projects', { keyPath: 'id' });
        projects.createIndex('lastOpenedAt', 'lastOpenedAt');

        const entries = db.createObjectStore('entries', { keyPath: ['projectId', 'path'] });
        entries.createIndex('projectId', 'projectId');
        entries.createIndex('hash', 'hash');

        db.createObjectStore('blobs', { keyPath: 'hash' });

        const snapshots = db.createObjectStore('snapshots', { keyPath: 'id' });
        snapshots.createIndex('projectId', 'projectId');
        snapshots.createIndex('projectCreatedAt', ['projectId', 'createdAt']);

        const snapshotFiles = db.createObjectStore('snapshotFiles', { keyPath: ['snapshotId', 'path'] });
        snapshotFiles.createIndex('snapshotId', 'snapshotId');

        const outbox = db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
        outbox.createIndex('projectId', 'projectId');

        db.createObjectStore('handles', { keyPath: 'projectId' });
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    },
  });
}

/**
 * IndexedDB in Chrome commits with "relaxed" durability by default, which can
 * lose the last transactions on a power cut. We ask for "strict" where it
 * matters (snapshots, settings) and accept relaxed for high-frequency autosave
 * writes. Browsers that do not know the option ignore it; the few that throw
 * are handled by the caller falling back to a plain transaction.
 */
export function durability(mode: 'strict' | 'relaxed'): { durability: 'strict' | 'relaxed' } | undefined {
  return { durability: mode };
}
