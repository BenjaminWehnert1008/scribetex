import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeGitHub } from '@/core/github/fake-github';
import { Vault } from '@/core/vault/vault';
import { GitHubBackup } from './github-backup';

let vault: Vault;
let github: FakeGitHub;

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  vault = await Vault.open({ name: `test-${Math.random().toString(36).slice(2)}` });
  github = new FakeGitHub();
  vi.stubGlobal('fetch', (url: string, init: { method: string; headers: Record<string, string>; body?: string }) =>
    github.fetch(url, { method: init.method, headers: init.headers, body: init.body }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('GitHubBackup', () => {
  it('notices when the repository is made private or public on GitHub', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const project = await vault.createProject({ name: 'Thesis' });
    github.isPrivate = false;
    const backup = await GitHubBackup.open(vault, project.id);
    await backup.connect('good-token', 'me/backups', 'Thesis');
    expect(backup.state.get().settings?.isPrivate).toBe(false);

    github.isPrivate = true;
    await backup.checkRepository();
    expect(backup.state.get().settings?.isPrivate).toBe(true);
    // Kept for the next visit.
    expect((await GitHubBackup.open(vault, project.id)).state.get().settings?.isPrivate).toBe(true);

    // Asked again only after a while.
    github.isPrivate = false;
    await backup.checkRepository();
    expect(backup.state.get().settings?.isPrivate).toBe(true);
    vi.setSystemTime(Date.now() + 6_000);
    await backup.checkRepository();
    expect(backup.state.get().settings?.isPrivate).toBe(false);
    backup.dispose();
  });

  it('takes the visibility from each backup', async () => {
    const project = await vault.createProject({ name: 'Thesis' });
    const backup = await GitHubBackup.open(vault, project.id);
    await backup.connect('good-token', 'me/backups', 'Thesis');
    expect(backup.state.get().settings?.isPrivate).toBe(true);
    github.isPrivate = false;
    await vault.writeFile(project.id, 'main.tex', new TextEncoder().encode('changed'), { origin: 'ui' });
    await backup.backupNow();
    expect(backup.state.get().settings?.isPrivate).toBe(false);
    backup.dispose();
  });

  it('keeps what it knew when GitHub cannot be reached', async () => {
    const project = await vault.createProject({ name: 'Thesis' });
    const backup = await GitHubBackup.open(vault, project.id);
    await backup.connect('good-token', 'me/backups', 'Thesis');
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    await backup.checkRepository();
    expect(backup.state.get().settings?.isPrivate).toBe(true);
    backup.dispose();
  });
});
