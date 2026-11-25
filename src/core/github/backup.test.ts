import { describe, expect, it } from 'vitest';
import { backupProject, downloadBackup, gitBlobId, GitHubClient, GitHubError, listBackupFolders, parseRepository } from './backup';
import { FakeGitHub } from './fake-github';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

const target = { owner: 'me', repo: 'backups', folder: 'Thesis' };

function setup() {
  const github = new FakeGitHub();
  return { github, client: new GitHubClient('good-token', github.fetch) };
}

describe('gitBlobId', () => {
  it('matches the ids git itself computes', async () => {
    // `printf '' | git hash-object --stdin` and `printf 'hello\n' | git hash-object --stdin`
    expect(await gitBlobId(text(''))).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
    expect(await gitBlobId(text('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });
});

describe('parseRepository', () => {
  it('accepts the short form and the address', () => {
    expect(parseRepository('me/backups')).toEqual({ owner: 'me', repo: 'backups' });
    expect(parseRepository(' https://github.com/Some-One/latex.backup.git ')).toEqual({ owner: 'Some-One', repo: 'latex.backup' });
    expect(parseRepository('https://github.com/me/backups/')).toEqual({ owner: 'me', repo: 'backups' });
  });

  it('rejects anything else', () => {
    expect(parseRepository('backups')).toBeNull();
    expect(parseRepository('me/back ups')).toBeNull();
    expect(parseRepository('me/backups/tree/main')).toBeNull();
  });
});

describe('backupProject', () => {
  it('makes the first backup in an empty repository, in the project folder', async () => {
    const { github, client } = setup();
    const result = await backupProject(client, target, [{ path: 'main.tex', bytes: text('root') }, { path: 'chapters/deep/intro.tex', bytes: text('intro') }], 'Backup');
    expect(result).toMatchObject({ changed: true, uploaded: 2, deleted: 0 });
    expect(result.commitUrl).toBe(`https://github.com/me/backups/commit/${github.head}`);
    expect(Object.keys(github.files())).toEqual(['README.md', 'Thesis/chapters/deep/intro.tex', 'Thesis/main.tex']);
    expect(github.files()['Thesis/chapters/deep/intro.tex']).toBe('intro');
  });

  it('sends only what changed and removes what is gone', async () => {
    const { github, client } = setup();
    await backupProject(client, target, [{ path: 'main.tex', bytes: text('v1') }, { path: 'old.tex', bytes: text('old') }, { path: 'refs.bib', bytes: text('bib') }], 'First');
    github.log = [];
    const result = await backupProject(client, target, [{ path: 'main.tex', bytes: text('v2') }, { path: 'refs.bib', bytes: text('bib') }, { path: 'new.tex', bytes: text('new') }], 'Second');

    expect(result).toMatchObject({ changed: true, uploaded: 2, deleted: 1 });
    expect(github.log.filter((line) => line.startsWith('POST') && line.endsWith('/git/blobs'))).toHaveLength(2);
    expect(github.files()).toEqual({ 'README.md': expect.any(String), 'Thesis/main.tex': 'v2', 'Thesis/new.tex': 'new', 'Thesis/refs.bib': 'bib' });
  });

  it('makes no commit when nothing changed', async () => {
    const { github, client } = setup();
    const files = [{ path: 'main.tex', bytes: text('same') }];
    const first = await backupProject(client, target, files, 'First');
    const commits = github.commitCount();
    const second = await backupProject(client, target, files, 'Second');
    expect(second).toMatchObject({ changed: false, commit: first.commit, uploaded: 0, deleted: 0 });
    expect(github.commitCount()).toBe(commits);
  });

  it('leaves other projects in the same repository alone', async () => {
    const { github, client } = setup();
    await backupProject(client, { ...target, folder: 'Paper' }, [{ path: 'paper.tex', bytes: text('paper') }], 'Paper');
    await backupProject(client, target, [{ path: 'main.tex', bytes: text('thesis') }], 'Thesis');
    await backupProject(client, target, [], 'Thesis emptied');
    expect(github.files()).toEqual({ 'README.md': expect.any(String), 'Paper/paper.tex': 'paper' });
  });

  it('does not mistake a folder with a longer name for its own', async () => {
    const { github, client } = setup();
    await backupProject(client, { ...target, folder: 'Thesis 2' }, [{ path: 'b.tex', bytes: text('b') }], 'Other');
    await backupProject(client, target, [{ path: 'a.tex', bytes: text('a') }], 'Mine');
    expect(Object.keys(github.files())).toEqual(['README.md', 'Thesis 2/b.tex', 'Thesis/a.tex']);
  });

  it('can use the top of the repository as the project folder', async () => {
    const { github, client } = setup();
    await backupProject(client, { ...target, folder: '' }, [{ path: 'main.tex', bytes: text('root') }], 'Root');
    expect(github.files()).toEqual({ 'main.tex': 'root' });
  });

  it('explains a wrong token', async () => {
    const github = new FakeGitHub();
    const client = new GitHubClient('wrong', github.fetch);
    await expect(backupProject(client, target, [], 'x')).rejects.toThrow('did not accept the token');
  });

  it('explains a token that may only read', async () => {
    const { github, client } = setup();
    github.canPush = false;
    await expect(backupProject(client, target, [], 'x')).rejects.toThrow('Contents: Read and write');
  });

  it('explains a repository it cannot see', async () => {
    const { client } = setup();
    const error = await backupProject(client, { owner: 'me', repo: 'missing', folder: '' }, [], 'x').catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).message).toContain('cannot find this repository');
  });

  it('explains being offline', async () => {
    const client = new GitHubClient('t', () => Promise.reject(new TypeError('Failed to fetch')));
    await expect(backupProject(client, target, [], 'x')).rejects.toThrow('could not be reached');
  });
});

describe('restoring', () => {
  it('lists the project folders and downloads one of them', async () => {
    const { client } = setup();
    await backupProject(client, target, [{ path: 'main.tex', bytes: text('thesis') }, { path: 'img/a.png', bytes: new Uint8Array([0, 255, 7, 200]) }], 'Thesis');
    await backupProject(client, { ...target, folder: 'Paper' }, [{ path: 'paper.tex', bytes: text('paper') }], 'Paper');

    expect(await listBackupFolders(client, target)).toEqual([
      { folder: 'Paper', files: 1 },
      { folder: 'Thesis', files: 2 },
    ]);
    const progress: string[] = [];
    const files = await downloadBackup(client, target, (done, total) => progress.push(`${done}/${total}`));
    expect(files.map((file) => file.path).sort()).toEqual(['img/a.png', 'main.tex']);
    expect([...files.find((file) => file.path === 'img/a.png')!.bytes]).toEqual([0, 255, 7, 200]);
    expect(progress).toEqual(['1/2', '2/2']);
  });

  it('finds nothing in an empty repository', async () => {
    const { client } = setup();
    expect(await listBackupFolders(client, target)).toEqual([]);
    expect(await downloadBackup(client, target)).toEqual([]);
  });
});
