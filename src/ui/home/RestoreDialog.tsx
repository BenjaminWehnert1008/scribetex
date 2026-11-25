import { useEffect, useState } from 'react';
import { adoptGitHubTarget, loadGitHubToken, saveGitHubToken } from '@/app/github-backup';
import type { Services } from '@/app/services';
import { downloadBackup, getRepository, GitHubClient, listBackupFolders, parseRepository } from '@/core/github/backup';
import { tryNormalizePath } from '@/core/paths';
import type { ProjectId } from '@/core/types';
import { Dialog } from '../common/ui';
import { NEW_TOKEN_URL } from '../workspace/GitHubCard';

/** Brings a project back from a GitHub backup, for example on a new computer. */
export function RestoreDialog(props: { services: Services; onClose: () => void; onRestored: (id: ProjectId) => void }) {
  const { vault } = props.services;
  const [repository, setRepository] = useState('');
  const [token, setToken] = useState('');
  const [stored, setStored] = useState<string | null>(null);
  const [folders, setFolders] = useState<{ folder: string; files: number }[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadGitHubToken(vault).then(setStored);
  }, [vault]);

  const fail = (reason: unknown): void => {
    setBusy(null);
    setError(reason instanceof Error ? reason.message : String(reason));
  };
  const usedToken = (): string => token.trim() || stored || '';

  const list = async (): Promise<void> => {
    const parsed = parseRepository(repository);
    if (!parsed) throw new Error('Write the repository as owner/name, for example anna/latex-backup.');
    if (!usedToken()) throw new Error('Paste a GitHub token first.');
    setFolders(await listBackupFolders(new GitHubClient(usedToken()), parsed));
    setBusy(null);
  };

  const restore = async (folder: string): Promise<void> => {
    const parsed = parseRepository(repository)!;
    const client = new GitHubClient(usedToken());
    const info = await getRepository(client, parsed);
    const files = await downloadBackup(client, { ...parsed, folder }, (done, total) => setBusy(`Downloading ${done} of ${total} files…`));
    const project = await vault.createProject({ name: folder });
    try {
      const usable = files.filter((file) => tryNormalizePath(file.path) !== null);
      await vault.writeMany(project.id, usable, { origin: 'import' });
      await saveGitHubToken(vault, usedToken());
      await adoptGitHubTarget(vault, project.id, { ...parsed, folder }, info.private);
    } catch (reason) {
      await vault.deleteProject(project.id).catch(() => undefined);
      throw reason;
    }
    props.onRestored(project.id);
  };

  return (
    <Dialog title="Restore a project from GitHub" wide onClose={busy ? undefined : props.onClose}>
      <p>
        Projects that were backed up to a GitHub repository can be brought into this browser. This creates a new project; nothing that is
        already here is changed.
      </p>
      <form
        style={{ display: 'grid', gap: 12, marginTop: 12 }}
        onSubmit={(event) => {
          event.preventDefault();
          setBusy('Looking for backups…');
          setError(null);
          setFolders(null);
          list().catch(fail);
        }}
      >
        <label className="stack">
          Repository
          <input className="field mono" value={repository} placeholder="your-name/latex-backup" required spellCheck={false} onChange={(event) => setRepository(event.target.value)} />
        </label>
        <label className="stack">
          {stored ? 'Token (leave empty to use the one stored in this browser)' : 'Token'}
          <input
            className="field mono"
            type="password"
            value={token}
            placeholder="github_pat_…"
            required={!stored}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
        {!stored && (
          <p className="muted" style={{ fontSize: 13 }}>
            On a new computer you need a new token:{' '}
            <a href={NEW_TOKEN_URL} target="_blank" rel="noreferrer">
              create a fine-grained token
            </a>{' '}
            for the backup repository with "Contents: Read and write". It is stored in this browser only.
          </p>
        )}
        <div className="actions" style={{ marginTop: 0, justifyContent: 'flex-start' }}>
          <button type="submit" className="btn" disabled={busy !== null}>
            Show the backups
          </button>
          {busy && <span className="muted">{busy}</span>}
        </div>
      </form>
      {error && (
        <p role="alert" style={{ color: 'var(--danger)', marginTop: 10 }}>
          {error}
        </p>
      )}
      {folders !== null && folders.length === 0 && <p style={{ marginTop: 12 }}>This repository has no project folders yet.</p>}
      {folders !== null && folders.length > 0 && (
        <ul className="project-list" style={{ marginTop: 12 }}>
          {folders.map((item) => (
            <li key={item.folder} className="project-row" style={{ gridTemplateColumns: '1fr auto' }}>
              <span>
                <span className="project-name">{item.folder}</span>
                <span className="project-meta" style={{ display: 'block' }}>
                  {item.files === 1 ? '1 file' : `${item.files} files`}
                </span>
              </span>
              <button
                className="btn small primary"
                disabled={busy !== null}
                onClick={() => {
                  setBusy('Downloading…');
                  setError(null);
                  restore(item.folder).catch(fail);
                }}
              >
                Restore
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="actions">
        <button className="btn" disabled={busy !== null} onClick={props.onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}
