/**
 * Snapshots: a full, restorable copy of a project at a point in time.
 *
 * A snapshot stores only metadata plus the list of (path, content hash) pairs.
 * Because file contents are content-addressed in the vault, a snapshot of an
 * unchanged project costs a few hundred bytes, so they can be taken often:
 * automatically while editing, and before anything destructive.
 *
 * Pruning keeps a dense recent history and thins it out going back, which is
 * what people need after a mistake: many fine-grained steps for the last hour,
 * a few per day for the last week.
 */
import { newId } from '../ids';
import { Emitter } from '../store';
import type { Millis, Path, ProjectId, SnapshotFile, SnapshotMeta, SnapshotReason } from '../types';
import type { Vault } from '../vault/vault';

export interface SnapshotPolicy {
  /** Keep every snapshot younger than this. */
  keepAllWithinMs: number;
  /** Then keep one per this many ms, up to `keepHourlyWithinMs`. */
  hourlyBucketMs: number;
  keepHourlyWithinMs: number;
  /** Then keep one per day, up to this age; older unpinned snapshots are dropped. */
  dailyBucketMs: number;
  keepDailyWithinMs: number;
  /** Hard cap on the number of snapshots kept per project. */
  maxPerProject: number;
}

export const DEFAULT_POLICY: SnapshotPolicy = {
  keepAllWithinMs: 60 * 60 * 1000, // the last hour, in full
  hourlyBucketMs: 60 * 60 * 1000,
  keepHourlyWithinMs: 24 * 60 * 60 * 1000, // hourly for a day
  dailyBucketMs: 24 * 60 * 60 * 1000,
  keepDailyWithinMs: 30 * 24 * 60 * 60 * 1000, // daily for a month
  maxPerProject: 200,
};

/** Reasons that mark a snapshot as worth keeping even when it is old. */
const PROTECTED_REASONS: ReadonlySet<SnapshotReason> = new Set([
  'manual',
  'before-restore',
  'before-import',
  'before-delete',
]);

export interface CreateSnapshotOptions {
  reason: SnapshotReason;
  label?: string | null;
  pinned?: boolean;
  /** Skip creating one when the content is identical to the newest snapshot. */
  skipIfUnchanged?: boolean;
}

export class SnapshotStore {
  readonly changes = new Emitter<{ projectId: ProjectId }>();
  readonly #vault: Vault;
  readonly #now: () => Millis;
  #policy: SnapshotPolicy;

  constructor(vault: Vault, options: { now?: () => Millis; policy?: SnapshotPolicy } = {}) {
    this.#vault = vault;
    this.#now = options.now ?? Date.now;
    this.#policy = options.policy ?? DEFAULT_POLICY;
  }

  setPolicy(policy: SnapshotPolicy): void {
    this.#policy = policy;
  }

  async list(projectId: ProjectId): Promise<SnapshotMeta[]> {
    const all = await this.#vault.db.getAllFromIndex('snapshots', 'projectId', projectId);
    return all.sort((a, b) => b.createdAt - a.createdAt);
  }

  async get(id: string): Promise<SnapshotMeta | undefined> {
    return this.#vault.db.get('snapshots', id);
  }

  async files(id: string): Promise<SnapshotFile[]> {
    const rows = await this.#vault.db.getAllFromIndex('snapshotFiles', 'snapshotId', id);
    return rows.map(({ path, kind, hash, size, text }) => ({ path, kind, hash, size, text }));
  }

  /**
   * Takes a snapshot of the project as it is in the vault right now.
   * Returns null when `skipIfUnchanged` was set and nothing changed.
   */
  async create(projectId: ProjectId, options: CreateSnapshotOptions): Promise<SnapshotMeta | null> {
    const entries = await this.#vault.list(projectId);
    const fingerprint = fingerprintOf(entries);

    if (options.skipIfUnchanged) {
      const [newest] = await this.list(projectId);
      if (newest) {
        const previous = await this.files(newest.id);
        if (fingerprintOf(previous) === fingerprint) return null;
      }
    }

    const now = this.#now();
    const meta: SnapshotMeta = {
      id: newId(now),
      projectId,
      createdAt: now,
      reason: options.reason,
      label: options.label ?? null,
      pinned: options.pinned ?? false,
      fileCount: entries.filter((entry) => entry.kind === 'file').length,
      totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    };

    const tx = this.#vault.transaction(['snapshots', 'snapshotFiles'], 'strict');
    await tx.objectStore('snapshots').put(meta);
    for (const entry of entries) {
      await tx.objectStore('snapshotFiles').put({
        snapshotId: meta.id,
        path: entry.path,
        kind: entry.kind,
        hash: entry.hash,
        size: entry.size,
        text: entry.text,
      });
    }
    await tx.done;

    this.changes.emit({ projectId });
    return meta;
  }

  /**
   * Restores a snapshot. A `before-restore` snapshot is taken first, so
   * restoring is itself undoable.
   */
  async restore(id: string): Promise<void> {
    const meta = await this.get(id);
    if (!meta) throw new Error(`No snapshot ${id}`);
    const files = await this.files(id);
    await this.create(meta.projectId, { reason: 'before-restore', skipIfUnchanged: true });
    await this.#vault.replaceAll(
      meta.projectId,
      files.map((file) => ({ path: file.path, kind: file.kind, hash: file.hash })),
      { origin: 'restore' },
    );
    this.changes.emit({ projectId: meta.projectId });
  }

  /** Reads one file out of a snapshot without restoring anything. */
  async readFile(id: string, path: Path): Promise<Uint8Array | null> {
    const row = await this.#vault.db.get('snapshotFiles', [id, path]);
    if (!row || row.kind === 'dir' || !row.hash) return null;
    try {
      return await this.#vault.readBlob(row.hash);
    } catch {
      return null;
    }
  }

  async setLabel(id: string, label: string | null): Promise<void> {
    await this.#update(id, (meta) => ({ ...meta, label }));
  }

  async setPinned(id: string, pinned: boolean): Promise<void> {
    await this.#update(id, (meta) => ({ ...meta, pinned }));
  }

  async delete(id: string): Promise<void> {
    const meta = await this.get(id);
    const tx = this.#vault.transaction(['snapshots', 'snapshotFiles'], 'relaxed');
    await tx.objectStore('snapshots').delete(id);
    for (const key of await tx.objectStore('snapshotFiles').index('snapshotId').getAllKeys(id)) {
      await tx.objectStore('snapshotFiles').delete(key);
    }
    await tx.done;
    if (meta) this.changes.emit({ projectId: meta.projectId });
  }

  /**
   * Applies the retention policy. Returns the ids that were removed.
   * Pinned, labelled and `PROTECTED_REASONS` snapshots are never removed, and
   * the newest snapshot always survives.
   */
  async prune(projectId: ProjectId, policy: SnapshotPolicy = this.#policy): Promise<string[]> {
    const all = await this.list(projectId);
    const now = this.#now();
    const keep = new Set<string>();
    const buckets = new Set<string>();

    for (const [index, snapshot] of all.entries()) {
      const age = now - snapshot.createdAt;
      const protectedSnapshot =
        index === 0 || snapshot.pinned || snapshot.label !== null || PROTECTED_REASONS.has(snapshot.reason);
      if (protectedSnapshot) {
        keep.add(snapshot.id);
        continue;
      }
      if (age <= policy.keepAllWithinMs) {
        keep.add(snapshot.id);
        continue;
      }
      // One per bucket: snapshots are newest first, so the first in each bucket
      // is the newest one in that bucket.
      let bucket: string | null = null;
      if (age <= policy.keepHourlyWithinMs) {
        bucket = `h${Math.floor(snapshot.createdAt / policy.hourlyBucketMs)}`;
      } else if (age <= policy.keepDailyWithinMs) {
        bucket = `d${Math.floor(snapshot.createdAt / policy.dailyBucketMs)}`;
      }
      if (bucket && !buckets.has(bucket)) {
        buckets.add(bucket);
        keep.add(snapshot.id);
      }
    }

    // Enforce the hard cap, dropping the oldest unprotected ones first.
    if (keep.size > policy.maxPerProject) {
      const droppable = all
        .filter(
          (snapshot, index) =>
            keep.has(snapshot.id) &&
            index !== 0 &&
            !snapshot.pinned &&
            snapshot.label === null &&
            !PROTECTED_REASONS.has(snapshot.reason),
        )
        .reverse();
      for (const snapshot of droppable) {
        if (keep.size <= policy.maxPerProject) break;
        keep.delete(snapshot.id);
      }
    }

    const removed = all.filter((snapshot) => !keep.has(snapshot.id)).map((snapshot) => snapshot.id);
    for (const id of removed) await this.delete(id);
    return removed;
  }

  async #update(id: string, patch: (meta: SnapshotMeta) => SnapshotMeta): Promise<void> {
    const tx = this.#vault.db.transaction('snapshots', 'readwrite');
    const meta = await tx.store.get(id);
    if (meta) await tx.store.put(patch(meta));
    await tx.done;
    if (meta) this.changes.emit({ projectId: meta.projectId });
  }
}

function fingerprintOf(files: { path: Path; hash: string | null; kind: string }[]): string {
  return files
    .map((file) => `${file.path}:${file.kind === 'dir' ? 'd' : file.hash}`)
    .sort()
    .join('\n');
}

/**
 * Deletes blobs that no file entry and no snapshot refers to any more.
 * A sweep is used rather than reference counts: a counter that drifted after a
 * crash would delete content that is still in use.
 */
export async function collectGarbage(vault: Vault): Promise<{ removed: number; freedBytes: number }> {
  const live = new Set<string>();
  for (const entry of await vault.db.getAll('entries')) if (entry.hash) live.add(entry.hash);
  for (const row of await vault.db.getAll('snapshotFiles')) if (row.hash) live.add(row.hash);

  let removed = 0;
  let freedBytes = 0;
  const tx = vault.db.transaction('blobs', 'readwrite');
  for await (const cursor of tx.store) {
    if (!live.has(cursor.value.hash)) {
      removed += 1;
      freedBytes += cursor.value.size;
      await cursor.delete();
    }
  }
  await tx.done;
  return { removed, freedBytes };
}
