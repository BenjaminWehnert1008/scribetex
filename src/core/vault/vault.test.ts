import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { encodeText } from '../hash';
import type { VaultChange } from '../types';
import { Vault, VaultError } from './vault';

let vault: Vault;
let projectId: string;
let seen: VaultChange[];

beforeEach(async () => {
  // A fresh in-memory IndexedDB per test.
  globalThis.indexedDB = new IDBFactory();
  vault = await Vault.open({ name: `test-${Math.random().toString(36).slice(2)}` });
  const project = await vault.createProject({ name: 'Thesis' });
  projectId = project.id;
  seen = [];
  vault.changes.on((change) => seen.push(change));
});

const paths = async () => (await vault.list(projectId)).map((e) => `${e.kind === 'dir' ? 'd' : 'f'} ${e.path}`).sort();

describe('projects', () => {
  it('creates, updates, lists and deletes projects', async () => {
    const second = await vault.createProject({ name: '  ' });
    expect(second.name).toBe('Untitled project');
    expect((await vault.listProjects()).map((p) => p.id)).toContain(projectId);

    await vault.updateProject(projectId, { engine: 'xelatex', mainFile: 'main.tex' });
    expect((await vault.getProject(projectId))!.engine).toBe('xelatex');

    await vault.deleteProject(second.id);
    expect(await vault.getProject(second.id)).toBeUndefined();
    expect(seen.at(-1)).toMatchObject({ type: 'project', project: null });
  });

  it('refuses writes to an unknown project', async () => {
    await expect(vault.writeText('nope', 'main.tex', 'x')).rejects.toThrow(VaultError);
  });
});

describe('nested folders', () => {
  it('creates parent folders implicitly and keeps them explicit', async () => {
    await vault.writeText(projectId, 'chapters/methods/setup.tex', 'hi');
    expect(await paths()).toEqual(['d chapters', 'd chapters/methods', 'f chapters/methods/setup.tex']);
    const entry = await vault.stat(projectId, 'chapters/methods/setup.tex');
    expect(entry).toMatchObject({ kind: 'file', size: 2, text: true });
    expect(entry!.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps an empty folder, which is the point of having folders at all', async () => {
    await vault.mkdir(projectId, 'figures/vector');
    expect(await paths()).toEqual(['d figures', 'd figures/vector']);
    // Reopening must not lose it.
    const again = await vault.mkdir(projectId, 'figures/vector');
    expect(again.kind).toBe('dir');
  });

  it('refuses a file and a folder at the same path', async () => {
    await vault.writeText(projectId, 'notes', 'x');
    await expect(vault.mkdir(projectId, 'notes')).rejects.toThrow(VaultError);
    await vault.mkdir(projectId, 'chapters');
    await expect(vault.writeText(projectId, 'chapters', 'x')).rejects.toThrow(VaultError);
    await expect(vault.writeText(projectId, 'notes/inner.tex', 'x')).rejects.toThrow(VaultError);
  });

  it('refuses siblings that differ only in case, because a linked folder could not hold both', async () => {
    await vault.writeText(projectId, 'figures/Plot.png', 'x');
    await expect(vault.writeText(projectId, 'figures/plot.png', 'y')).rejects.toThrow(/upper and lower case/);
  });

  it('counts files and bytes for the project list', async () => {
    await vault.writeText(projectId, 'a.tex', 'hello');
    await vault.writeText(projectId, 'b/c.tex', 'hi');
    let project = await vault.requireProject(projectId);
    expect([project.fileCount, project.totalBytes]).toEqual([2, 7]);
    await vault.writeText(projectId, 'a.tex', 'hello world');
    project = await vault.requireProject(projectId);
    expect([project.fileCount, project.totalBytes]).toEqual([2, 13]);
    await vault.remove(projectId, 'b');
    project = await vault.requireProject(projectId);
    expect([project.fileCount, project.totalBytes]).toEqual([1, 11]);
  });
});

describe('read and write', () => {
  it('round-trips text and bytes', async () => {
    await vault.writeText(projectId, 'main.tex', 'Größe ∑');
    expect(await vault.readText(projectId, 'main.tex')).toBe('Größe ∑');
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
    await vault.writeFile(projectId, 'figures/plot.png', png);
    expect(Array.from(await vault.readBytes(projectId, 'figures/plot.png'))).toEqual(Array.from(png));
    expect((await vault.stat(projectId, 'figures/plot.png'))!.text).toBe(false);
  });

  it('shares one blob between identical files', async () => {
    await vault.writeText(projectId, 'a.tex', 'same');
    await vault.writeText(projectId, 'b/a.tex', 'same');
    expect(await vault.db.count('blobs')).toBe(1);
  });

  it('reports a missing file instead of returning empty content', async () => {
    await expect(vault.readBytes(projectId, 'ghost.tex')).rejects.toThrow(VaultError);
    await vault.mkdir(projectId, 'dir');
    await expect(vault.readBytes(projectId, 'dir')).rejects.toThrow(/folder/);
  });
});

describe('remove and move', () => {
  it('removes a folder with everything inside it', async () => {
    await vault.writeText(projectId, 'chapters/intro.tex', 'a');
    await vault.writeText(projectId, 'chapters/sub/deep.tex', 'b');
    await vault.writeText(projectId, 'main.tex', 'c');
    const removed = await vault.remove(projectId, 'chapters');
    expect(removed.sort()).toEqual(['chapters', 'chapters/intro.tex', 'chapters/sub', 'chapters/sub/deep.tex']);
    expect(await paths()).toEqual(['f main.tex']);
  });

  it('moves a folder and rewrites every path inside it', async () => {
    await vault.writeText(projectId, 'old/a.tex', 'a');
    await vault.writeText(projectId, 'old/sub/b.tex', 'b');
    await vault.move(projectId, 'old', 'new/place');
    expect(await paths()).toEqual(['d new', 'd new/place', 'd new/place/sub', 'f new/place/a.tex', 'f new/place/sub/b.tex']);
    expect(await vault.readText(projectId, 'new/place/sub/b.tex')).toBe('b');
  });

  it('renames in place and keeps the parent folder', async () => {
    await vault.writeText(projectId, 'chapters/intro.tex', 'a');
    const to = await vault.rename(projectId, 'chapters/intro.tex', 'einleitung.tex');
    expect(to).toBe('chapters/einleitung.tex');
    expect(await vault.exists(projectId, 'chapters/einleitung.tex')).toBe(true);
  });

  it('refuses impossible moves', async () => {
    await vault.writeText(projectId, 'a/b.tex', 'x');
    await vault.writeText(projectId, 'c.tex', 'y');
    await expect(vault.move(projectId, 'a', 'a/inside')).rejects.toThrow(/into itself/);
    await expect(vault.move(projectId, 'a/b.tex', 'c.tex')).rejects.toThrow(/already exists/);
    await expect(vault.move(projectId, 'ghost.tex', 'z.tex')).rejects.toThrow(VaultError);
    await expect(vault.remove(projectId, '')).rejects.toThrow(VaultError);
  });

  it('allows a pure case rename', async () => {
    await vault.writeText(projectId, 'Main.tex', 'x');
    await vault.move(projectId, 'Main.tex', 'main.tex');
    expect(await paths()).toEqual(['f main.tex']);
  });

  it('removing a missing path is not an error', async () => {
    expect(await vault.remove(projectId, 'ghost')).toEqual([]);
  });
});

describe('bulk writes', () => {
  it('imports a tree in one transaction', async () => {
    await vault.writeMany(projectId, [
      { path: 'main.tex', bytes: encodeText('root') },
      { path: 'chapters/intro.tex', bytes: encodeText('intro') },
      { path: 'figures/vector', kind: 'dir' },
    ]);
    expect(await paths()).toEqual([
      'd chapters',
      'd figures',
      'd figures/vector',
      'f chapters/intro.tex',
      'f main.tex',
    ]);
    expect(seen.filter((c) => c.type === 'bulk')).toHaveLength(1);
    expect((await vault.requireProject(projectId)).fileCount).toBe(2);
  });

  it('replaceAll restores exactly one state and drops leftovers', async () => {
    await vault.writeText(projectId, 'keep.tex', 'v1');
    await vault.writeText(projectId, 'gone.tex', 'bye');
    const oldHash = (await vault.stat(projectId, 'keep.tex'))!.hash!;
    await vault.writeText(projectId, 'keep.tex', 'v2');

    await vault.replaceAll(projectId, [{ path: 'keep.tex', kind: 'file', hash: oldHash }]);
    expect(await paths()).toEqual(['f keep.tex']);
    expect(await vault.readText(projectId, 'keep.tex')).toBe('v1');
    const project = await vault.requireProject(projectId);
    expect([project.fileCount, project.totalBytes]).toEqual([1, 2]);
  });
});

describe('mirror queue', () => {
  const link = { folderName: 'Thesis', linkedAt: 0, lastSyncAt: null, writePdf: false };

  it('stays empty for a project that is not linked to a folder', async () => {
    await vault.writeText(projectId, 'a.tex', 'x');
    await vault.remove(projectId, 'a.tex');
    expect(await vault.countPendingMirror(projectId)).toBe(0);
  });

  it('queues every change for the linked folder, in order', async () => {
    await vault.updateProject(projectId, { link });
    await vault.writeText(projectId, 'chapters/intro.tex', 'a');
    await vault.move(projectId, 'chapters/intro.tex', 'chapters/einleitung.tex');
    await vault.remove(projectId, 'chapters');
    const queue = (await vault.pendingMirror(projectId)).map((i) => `${i.op} ${i.path}${i.to ? ' -> ' + i.to : ''}`);
    expect(queue).toEqual([
      'write chapters',
      'write chapters/intro.tex',
      'move chapters/intro.tex -> chapters/einleitung.tex',
      'remove chapters',
    ]);
  });

  it('skips the queue for changes that came from disk', async () => {
    await vault.updateProject(projectId, { link });
    await vault.writeText(projectId, 'a.tex', 'from disk', { origin: 'folder', skipMirror: true });
    expect(await vault.countPendingMirror(projectId)).toBe(0);
    expect(seen.at(-1)).toMatchObject({ type: 'write', origin: 'folder' });
  });

  it('tracks attempts and can be cleared', async () => {
    await vault.updateProject(projectId, { link });
    await vault.writeText(projectId, 'a.tex', 'x');
    const [item] = await vault.pendingMirror(projectId);
    await vault.markMirrorFailed(item!.seq!, 'permission denied');
    expect((await vault.pendingMirror(projectId))[0]).toMatchObject({ attempts: 1, lastError: 'permission denied' });
    await vault.clearMirrorItem(item!.seq!);
    expect(await vault.countPendingMirror(projectId)).toBe(0);
  });

  it('queues the whole project when a folder is linked, parents before children', async () => {
    await vault.updateProject(projectId, { link });
    await vault.writeText(projectId, 'chapters/sub/deep.tex', 'x');
    await vault.clearMirrorQueue(projectId);
    const count = await vault.queueFullMirror(projectId);
    expect(count).toBe(3);
    const queue = await vault.pendingMirror(projectId);
    expect(queue.map((i) => i.path)).toEqual(['chapters', 'chapters/sub', 'chapters/sub/deep.tex']);
  });
});

describe('settings, handles and names', () => {
  it('stores settings with a fallback', async () => {
    expect(await vault.getSetting('theme', 'system')).toBe('system');
    await vault.setSetting('theme', 'dark');
    expect(await vault.getSetting('theme', 'system')).toBe('dark');
  });

  it('forgets a directory handle on request', async () => {
    const fake = { name: 'thesis', kind: 'directory' } as unknown as FileSystemDirectoryHandle;
    await vault.saveHandle(projectId, fake);
    expect((await vault.loadHandle(projectId))!.name).toBe('thesis');
    await vault.forgetHandle(projectId);
    expect(await vault.loadHandle(projectId)).toBeNull();
  });

  it('suggests a free name inside a folder', async () => {
    await vault.writeText(projectId, 'figures/plot.png', 'x');
    expect(await vault.suggestName(projectId, 'figures', 'plot.png')).toBe('plot (2).png');
    expect(await vault.suggestName(projectId, '', 'plot.png')).toBe('plot.png');
  });

  it('deleting a project removes its files, snapshots and queue', async () => {
    await vault.writeText(projectId, 'a.tex', 'x');
    await vault.deleteProject(projectId);
    expect(await vault.db.count('entries')).toBe(0);
    expect(await vault.db.count('outbox')).toBe(0);
  });
});
