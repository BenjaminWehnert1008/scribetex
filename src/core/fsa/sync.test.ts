import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import type { VaultChange } from '../types';
import { Vault } from '../vault/vault';
import { MemoryFolder } from './memory-folder';
import { FolderSync } from './sync';

let vault: Vault;
let projectId: string;
let folder: MemoryFolder;
let sync: FolderSync;
let changes: VaultChange[];
let versionsSaved: number;
let clock: number;

const projectFiles = async (): Promise<string[]> => (await vault.list(projectId)).map((entry) => (entry.kind === 'dir' ? `${entry.path}/` : entry.path)).sort();

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  vault = await Vault.open({ name: `sync-${Math.random().toString(36).slice(2)}` });
  projectId = (await vault.createProject({ name: 'Thesis', mainFile: 'main.tex' })).id;
  folder = new MemoryFolder('Thesis');
  versionsSaved = 0;
  clock = 5_000;
  sync = await FolderSync.open(vault, projectId, {
    beforeIncoming: async () => {
      versionsSaved++;
    },
    now: () => ++clock,
  });
  changes = [];
  vault.changes.on((change) => changes.push(change));
});

describe('linking', () => {
  it('starts unlinked', () => {
    expect(sync.state.get().status).toBe('off');
    expect(sync.linked).toBe(false);
  });

  it('writes the whole project into an empty folder, with its folders', async () => {
    await vault.writeText(projectId, 'main.tex', 'root');
    await vault.writeText(projectId, 'chapters/deep/intro.tex', 'intro');
    await vault.mkdir(projectId, 'figures');
    await sync.link(folder);

    expect(folder.list()).toEqual(['chapters/', 'chapters/deep/', 'chapters/deep/intro.tex', 'figures/', 'main.tex']);
    expect(folder.text('chapters/deep/intro.tex')).toBe('intro');
    expect(sync.state.get()).toMatchObject({ status: 'synced', folderName: 'Thesis', problems: [], missing: null });
    const project = await vault.requireProject(projectId);
    expect(project.link).toMatchObject({ folderName: 'Thesis', writePdf: true });
    expect(project.link!.lastSyncAt).not.toBeNull();
  });

  it('takes an existing folder into an empty project, leaving out what does not belong', async () => {
    folder.put('paper.tex', 'paper');
    folder.put('img/plot.png', 'png');
    folder.put('paper.aux', 'aux');
    folder.put('.git/config', 'git');
    folder.put('.DS_Store', 'x');
    folder.put('paper.tex.crswap', 'half');
    await sync.link(folder);

    expect(await projectFiles()).toEqual(['img/', 'img/plot.png', 'paper.tex']);
    expect(await vault.readText(projectId, 'paper.tex')).toBe('paper');
    // The files that were left out are still on disk, untouched.
    expect(folder.text('.git/config')).toBe('git');
    expect(folder.text('paper.aux')).toBe('aux');
  });

  it('merges a folder and a project that both have files, keeping both versions of a file that differs', async () => {
    await vault.writeText(projectId, 'main.tex', 'from the browser');
    await vault.writeText(projectId, 'only-here.tex', 'a');
    folder.put('main.tex', 'from the folder');
    folder.put('only-there.tex', 'b');
    await sync.link(folder);

    expect(await projectFiles()).toEqual(['main (folder copy).tex', 'main.tex', 'only-here.tex', 'only-there.tex']);
    expect(folder.list()).toEqual(['main (folder copy).tex', 'main.tex', 'only-here.tex', 'only-there.tex']);
    expect(folder.text('main.tex')).toBe('from the browser');
    expect(folder.text('main (folder copy).tex')).toBe('from the folder');
    expect(await vault.readText(projectId, 'main (folder copy).tex')).toBe('from the folder');
    expect(sync.state.get().conflicts).toEqual(['main (folder copy).tex']);
  });

  it('refuses a folder the browser may not write to', async () => {
    folder.permission = 'prompt';
    folder.answer = 'denied';
    await expect(sync.link(folder)).rejects.toThrow('not allowed');
    expect((await vault.requireProject(projectId)).link).toBeNull();
  });

  it('unlinks without deleting anything on either side', async () => {
    await vault.writeText(projectId, 'main.tex', 'root');
    await sync.link(folder);
    await sync.unlink();
    expect(sync.state.get().status).toBe('off');
    expect((await vault.requireProject(projectId)).link).toBeNull();
    expect(folder.list()).toEqual(['main.tex']);
    expect(await projectFiles()).toEqual(['main.tex']);
    // Later changes no longer reach the folder.
    await vault.writeText(projectId, 'main.tex', 'changed');
    await sync.request();
    expect(folder.text('main.tex')).toBe('root');
  });
});

describe('a linked project', () => {
  beforeEach(async () => {
    await vault.writeText(projectId, 'main.tex', 'v1');
    await vault.writeText(projectId, 'chapters/intro.tex', 'intro v1');
    await vault.writeText(projectId, 'refs.bib', 'bib v1');
    await sync.link(folder);
    changes = [];
    versionsSaved = 0;
  });

  it('writes edits, new files, renames and deletions to the folder', async () => {
    await vault.writeText(projectId, 'main.tex', 'v2');
    await vault.writeText(projectId, 'figures/new/plot.tex', 'plot');
    await vault.rename(projectId, 'refs.bib', 'library.bib');
    await vault.remove(projectId, 'chapters');
    expect(await vault.countPendingMirror(projectId)).toBeGreaterThan(0);
    await sync.request();

    expect(folder.list()).toEqual(['figures/', 'figures/new/', 'figures/new/plot.tex', 'library.bib', 'main.tex']);
    expect(folder.text('main.tex')).toBe('v2');
    expect(folder.text('library.bib')).toBe('bib v1');
    expect(await vault.countPendingMirror(projectId)).toBe(0);
    expect(versionsSaved).toBe(0);
  });

  it('takes edits, new files and folders from the folder into the project', async () => {
    folder.put('main.tex', 'edited outside');
    folder.put('sections/a/one.tex', 'one');
    folder.mkdir('empty');
    await sync.request();

    expect(await vault.readText(projectId, 'main.tex')).toBe('edited outside');
    expect(await projectFiles()).toEqual(['chapters/', 'chapters/intro.tex', 'empty/', 'main.tex', 'refs.bib', 'sections/', 'sections/a/', 'sections/a/one.tex']);
    expect(changes.filter((change) => change.type !== 'project').every((change) => 'origin' in change && change.origin === 'folder')).toBe(true);
    // Changes that came from the folder are not queued to be written back to it.
    expect(await vault.countPendingMirror(projectId)).toBe(0);
    // A version was saved first, because a project file was about to be overwritten.
    expect(versionsSaved).toBe(1);
  });

  it('does not save a version for files that are only added', async () => {
    folder.put('extra.tex', 'x');
    await sync.request();
    expect(await vault.exists(projectId, 'extra.tex')).toBe(true);
    expect(versionsSaved).toBe(0);
  });

  it('removes from the project what was deleted in the folder', async () => {
    folder.delete('refs.bib');
    await sync.request();
    expect(await projectFiles()).toEqual(['chapters/', 'chapters/intro.tex', 'main.tex']);
    expect(versionsSaved).toBe(1);
    expect(sync.state.get().status).toBe('synced');
  });

  it('keeps both versions when a file changed on both sides', async () => {
    await vault.writeText(projectId, 'chapters/intro.tex', 'mine');
    folder.put('chapters/intro.tex', 'theirs');
    await sync.request();

    expect(await vault.readText(projectId, 'chapters/intro.tex')).toBe('mine');
    expect(await vault.readText(projectId, 'chapters/intro (folder copy).tex')).toBe('theirs');
    expect(folder.text('chapters/intro.tex')).toBe('mine');
    expect(folder.text('chapters/intro (folder copy).tex')).toBe('theirs');
    expect(sync.state.get().conflicts).toEqual(['chapters/intro (folder copy).tex']);

    // The next pass finds everything in agreement.
    changes = [];
    await sync.request();
    expect(changes.filter((change) => change.type !== 'project')).toEqual([]);
    expect(folder.list().filter((name) => name.includes('folder copy'))).toHaveLength(1);
  });

  it('lets an edit in the browser win over a deletion in the folder', async () => {
    await vault.writeText(projectId, 'refs.bib', 'bib v2');
    folder.delete('refs.bib');
    await sync.request();
    expect(folder.text('refs.bib')).toBe('bib v2');
    expect(await vault.readText(projectId, 'refs.bib')).toBe('bib v2');
  });

  it('does nothing when a file was only touched', async () => {
    folder.put('main.tex', 'v1');
    await sync.request();
    expect(changes.filter((change) => change.type !== 'project')).toEqual([]);
    expect(sync.state.get().status).toBe('synced');
  });

  it('does not delete the project when the folder was emptied, and asks instead', async () => {
    folder.delete('main.tex');
    folder.delete('refs.bib');
    folder.delete('chapters');
    await sync.request();

    expect(await projectFiles()).toEqual(['chapters/', 'chapters/intro.tex', 'main.tex', 'refs.bib']);
    expect(sync.state.get()).toMatchObject({ status: 'attention', missing: ['chapters/intro.tex', 'main.tex', 'refs.bib'] });
    expect(versionsSaved).toBe(0);
  });

  it('writes the files back when the user says the folder was emptied by mistake', async () => {
    folder.delete('main.tex');
    folder.delete('refs.bib');
    folder.delete('chapters');
    await sync.request();
    await sync.request({ massDeletion: 'restore' });
    expect(folder.list()).toEqual(['chapters/', 'chapters/intro.tex', 'main.tex', 'refs.bib']);
    expect(sync.state.get()).toMatchObject({ status: 'synced', missing: null });
  });

  it('deletes in the project when the user confirms the deletions', async () => {
    folder.delete('main.tex');
    folder.delete('refs.bib');
    folder.delete('chapters');
    await sync.request();
    await sync.request({ massDeletion: 'apply' });
    expect(await projectFiles()).toEqual([]);
    expect(versionsSaved).toBe(1);
    expect(sync.state.get()).toMatchObject({ status: 'synced', missing: null });
  });

  it('waits for permission and keeps count of what is waiting', async () => {
    folder.permission = 'prompt';
    await vault.writeText(projectId, 'main.tex', 'v2');
    await sync.request();
    expect(sync.state.get()).toMatchObject({ status: 'needs-permission', waiting: 1 });
    expect(folder.children.get('main.tex')).toBeDefined();

    folder.answer = 'granted';
    expect(await sync.reconnect()).toBe(true);
    expect(folder.text('main.tex')).toBe('v2');
    expect(sync.state.get()).toMatchObject({ status: 'synced', waiting: 0 });
  });

  it('writes the compiled PDF next to the main file and does not take it back in', async () => {
    sync.setOutput(new TextEncoder().encode('%PDF-1.7 fake'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await sync.request();
    expect(folder.text('main.pdf')).toBe('%PDF-1.7 fake');
    await sync.request();
    expect(await vault.exists(projectId, 'main.pdf')).toBe(false);
  });

  it('reports a name it cannot take without stopping the rest', async () => {
    folder.put('what?.tex', 'odd');
    folder.put('fine.tex', 'ok');
    await sync.request();
    expect(await vault.exists(projectId, 'fine.tex')).toBe(true);
    expect(sync.state.get().status).toBe('attention');
    expect(sync.state.get().problems.join(' ')).toContain('what?.tex');
  });

  it('runs one more pass for a request that arrives while one is running', async () => {
    const first = sync.request();
    await vault.writeText(projectId, 'late.tex', 'late');
    const second = sync.request();
    await Promise.all([first, second]);
    expect(folder.text('late.tex')).toBe('late');
  });
});
