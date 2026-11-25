import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { Vault } from '../vault/vault';
import { collectGarbage, DEFAULT_POLICY, SnapshotStore } from './snapshots';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let vault: Vault;
let snapshots: SnapshotStore;
let projectId: string;
let clock = 1_700_000_000_000;

const now = () => clock;

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  clock = 1_700_000_000_000;
  vault = await Vault.open({ name: `snap-${Math.random().toString(36).slice(2)}`, now });
  snapshots = new SnapshotStore(vault, { now });
  projectId = (await vault.createProject({ name: 'Thesis' })).id;
});

describe('create', () => {
  it('records every file and folder, and is cheap for unchanged content', async () => {
    await vault.writeText(projectId, 'main.tex', 'v1');
    await vault.mkdir(projectId, 'figures/vector');
    const first = await snapshots.create(projectId, { reason: 'manual', label: 'Before rewrite' });
    expect(first).not.toBeNull();
    expect(first!.fileCount).toBe(1);
    expect((await snapshots.files(first!.id)).map((f) => `${f.kind} ${f.path}`).sort()).toEqual([
      'dir figures',
      'dir figures/vector',
      'file main.tex',
    ]);

    clock += 1000;
    expect(await snapshots.create(projectId, { reason: 'auto', skipIfUnchanged: true })).toBeNull();
    await vault.writeText(projectId, 'main.tex', 'v2');
    expect(await snapshots.create(projectId, { reason: 'auto', skipIfUnchanged: true })).not.toBeNull();
    expect(await snapshots.list(projectId)).toHaveLength(2);
  });

  it('notices a rename even when the content is the same', async () => {
    await vault.writeText(projectId, 'a.tex', 'same');
    await snapshots.create(projectId, { reason: 'manual' });
    clock += 1000;
    await vault.move(projectId, 'a.tex', 'b.tex');
    expect(await snapshots.create(projectId, { reason: 'auto', skipIfUnchanged: true })).not.toBeNull();
  });

  it('lists newest first', async () => {
    await vault.writeText(projectId, 'a.tex', '1');
    const a = await snapshots.create(projectId, { reason: 'manual' });
    clock += 5000;
    await vault.writeText(projectId, 'a.tex', '2');
    const b = await snapshots.create(projectId, { reason: 'manual' });
    expect((await snapshots.list(projectId)).map((s) => s.id)).toEqual([b!.id, a!.id]);
  });
});

describe('restore', () => {
  it('brings back old content, removes files added since, and is itself undoable', async () => {
    await vault.writeText(projectId, 'main.tex', 'original');
    await vault.writeText(projectId, 'keep.tex', 'keep');
    const good = await snapshots.create(projectId, { reason: 'manual', label: 'good' });

    clock += HOUR;
    await vault.writeText(projectId, 'main.tex', 'broken');
    await vault.writeText(projectId, 'added-later.tex', 'oops');
    await vault.remove(projectId, 'keep.tex');

    await snapshots.restore(good!.id);
    expect(await vault.readText(projectId, 'main.tex')).toBe('original');
    expect(await vault.readText(projectId, 'keep.tex')).toBe('keep');
    expect(await vault.exists(projectId, 'added-later.tex')).toBe(false);

    // The state just before the restore was captured, so the restore can be undone.
    const beforeRestore = (await snapshots.list(projectId)).find((s) => s.reason === 'before-restore');
    expect(beforeRestore).toBeDefined();
    await snapshots.restore(beforeRestore!.id);
    expect(await vault.readText(projectId, 'main.tex')).toBe('broken');
    expect(await vault.exists(projectId, 'added-later.tex')).toBe(true);
  });

  it('restores empty folders too', async () => {
    await vault.mkdir(projectId, 'figures/vector');
    const snap = await snapshots.create(projectId, { reason: 'manual' });
    await vault.remove(projectId, 'figures');
    await snapshots.restore(snap!.id);
    expect((await vault.list(projectId)).map((e) => e.path).sort()).toEqual(['figures', 'figures/vector']);
  });

  it('reads a single file out of a snapshot without touching the project', async () => {
    await vault.writeText(projectId, 'main.tex', 'old');
    const snap = await snapshots.create(projectId, { reason: 'manual' });
    await vault.writeText(projectId, 'main.tex', 'new');
    const bytes = await snapshots.readFile(snap!.id, 'main.tex');
    expect(new TextDecoder().decode(bytes!)).toBe('old');
    expect(await vault.readText(projectId, 'main.tex')).toBe('new');
    expect(await snapshots.readFile(snap!.id, 'ghost.tex')).toBeNull();
  });

  it('refuses an unknown snapshot', async () => {
    await expect(snapshots.restore('nope')).rejects.toThrow(/No snapshot/);
  });
});

describe('prune', () => {
  /** Lays down one automatic snapshot every `stepMs`, oldest first. */
  async function fill(count: number, stepMs: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await vault.writeText(projectId, 'main.tex', `v${i}`);
      await snapshots.create(projectId, { reason: 'auto' });
      clock += stepMs;
    }
  }

  it('keeps everything from the last hour', async () => {
    await fill(10, 5 * 60 * 1000); // every 5 minutes for 50 minutes
    expect(await snapshots.prune(projectId)).toEqual([]);
    expect(await snapshots.list(projectId)).toHaveLength(10);
  });

  it('thins older snapshots to one per hour, then one per day', async () => {
    await fill(24 * 4, 15 * 60 * 1000); // every 15 minutes for 24 hours
    clock += HOUR;
    await snapshots.prune(projectId);
    const kept = await snapshots.list(projectId);
    // The last hour is dense (4 per hour), the previous 23 hours are hourly.
    expect(kept.length).toBeGreaterThan(20);
    expect(kept.length).toBeLessThan(35);

    // Two months on, only the newest and the protected ones remain.
    clock += 60 * DAY;
    await snapshots.prune(projectId);
    expect(await snapshots.list(projectId)).toHaveLength(1);
  });

  it('never drops pinned, labelled, manual or pre-destruction snapshots', async () => {
    await vault.writeText(projectId, 'main.tex', 'x');
    const manual = await snapshots.create(projectId, { reason: 'manual' });
    clock += 1000;
    await vault.writeText(projectId, 'main.tex', 'y');
    const beforeDelete = await snapshots.create(projectId, { reason: 'before-delete' });
    clock += 1000;
    await vault.writeText(projectId, 'main.tex', 'z');
    const pinned = await snapshots.create(projectId, { reason: 'auto' });
    await snapshots.setPinned(pinned!.id, true);
    clock += 1000;
    await vault.writeText(projectId, 'main.tex', 'w');
    const labelled = await snapshots.create(projectId, { reason: 'auto' });
    await snapshots.setLabel(labelled!.id, 'submission');
    clock += 1000;
    await vault.writeText(projectId, 'main.tex', 'plain');
    const plain = await snapshots.create(projectId, { reason: 'auto' });

    clock += 400 * DAY;
    const removed = await snapshots.prune(projectId);
    const kept = (await snapshots.list(projectId)).map((s) => s.id).sort();
    expect(removed).toEqual([]);
    expect(kept).toEqual([manual!.id, beforeDelete!.id, pinned!.id, labelled!.id, plain!.id].sort());
  });

  it('enforces the hard cap', async () => {
    const policy = { ...DEFAULT_POLICY, maxPerProject: 5, keepAllWithinMs: 10 * DAY };
    await fill(12, 60 * 1000);
    const removed = await snapshots.prune(projectId, policy);
    expect(removed).toHaveLength(7);
    expect(await snapshots.list(projectId)).toHaveLength(5);
  });

  it('deleting a snapshot leaves the project untouched', async () => {
    await vault.writeText(projectId, 'main.tex', 'x');
    const snap = await snapshots.create(projectId, { reason: 'manual' });
    await snapshots.delete(snap!.id);
    expect(await snapshots.list(projectId)).toHaveLength(0);
    expect(await vault.readText(projectId, 'main.tex')).toBe('x');
    expect(await vault.db.count('snapshotFiles')).toBe(0);
  });
});

describe('collectGarbage', () => {
  it('frees content that no file and no snapshot still needs', async () => {
    await vault.writeText(projectId, 'main.tex', 'version one');
    const snap = await snapshots.create(projectId, { reason: 'manual' });
    await vault.writeText(projectId, 'main.tex', 'version two');
    await vault.writeText(projectId, 'scratch.tex', 'temporary');
    await vault.remove(projectId, 'scratch.tex');

    // Three blobs exist; the snapshot still holds the first one.
    expect(await vault.db.count('blobs')).toBe(3);
    let result = await collectGarbage(vault);
    expect(result.removed).toBe(1); // only the deleted scratch file
    expect(result.freedBytes).toBe(9);
    expect(new TextDecoder().decode((await snapshots.readFile(snap!.id, 'main.tex'))!)).toBe('version one');

    // Once the snapshot is gone, the old version can be collected too.
    await snapshots.delete(snap!.id);
    result = await collectGarbage(vault);
    expect(result.removed).toBe(1);
    expect(await vault.db.count('blobs')).toBe(1);
    expect(await vault.readText(projectId, 'main.tex')).toBe('version two');
  });

  it('does nothing when everything is referenced', async () => {
    await vault.writeText(projectId, 'a.tex', 'x');
    expect(await collectGarbage(vault)).toEqual({ removed: 0, freedBytes: 0 });
  });
});
