/**
 * The optional backup of one project to a private GitHub repository: its
 * settings, the token, and when a backup runs. The requests themselves are in
 * `core/github/backup.ts`.
 *
 * The token is kept in this browser's storage only. It is never part of a ZIP
 * export, a linked folder or the backup itself.
 */
import { backupProject, type BackupFile, type BackupResult, getRepository, GitHubClient, type GitHubTarget, parseRepository } from '@/core/github/backup';
import { isBuildArtifact } from '@/core/latex/deps';
import { tryNormalizePath } from '@/core/paths';
import { Store } from '@/core/store';
import type { Millis, ProjectId } from '@/core/types';
import type { Vault } from '@/core/vault/vault';

export interface GitHubSettings {
  target: GitHubTarget;
  /** Back up by itself a while after changes. */
  auto: boolean;
  isPrivate: boolean;
  lastBackupAt: Millis | null;
  lastCommitUrl: string | null;
}

export interface GitHubState {
  status: 'off' | 'idle' | 'running' | 'failed';
  settings: GitHubSettings | null;
  /** Whether a token is stored in this browser (for any project). */
  hasToken: boolean;
  error: string | null;
  /** True when the project changed after the last backup. */
  behind: boolean;
}

const TOKEN_KEY = 'github:token';
const settingsKey = (projectId: ProjectId): string => `github:project:${projectId}`;
const AUTO_DELAY_MS = 60_000;
const MIN_INTERVAL_MS = 5 * 60_000;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** A repository's visibility is asked for at most this often. */
const VISIBILITY_CHECK_MS = 5_000;

export async function loadGitHubToken(vault: Vault): Promise<string | null> {
  return vault.getSetting<string | null>(TOKEN_KEY, null);
}

export async function saveGitHubToken(vault: Vault, token: string | null): Promise<void> {
  await vault.setSetting(TOKEN_KEY, token);
}

/** The files of a project as they go into a backup: everything except build leftovers. */
export async function collectBackupFiles(vault: Vault, projectId: ProjectId): Promise<{ files: BackupFile[]; skipped: string[] }> {
  const files: BackupFile[] = [];
  const skipped: string[] = [];
  for (const entry of await vault.list(projectId)) {
    if (entry.kind !== 'file' || isBuildArtifact(entry.path)) continue;
    if (entry.size > MAX_FILE_BYTES) {
      skipped.push(entry.path);
      continue;
    }
    files.push({ path: entry.path, bytes: await vault.readBytes(projectId, entry.path) });
  }
  return { files, skipped };
}

export class GitHubBackup {
  readonly state: Store<GitHubState>;
  readonly #vault: Vault;
  readonly #projectId: ProjectId;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running: Promise<BackupResult | null> | null = null;
  #checkedAt = 0;
  #disposed = false;

  private constructor(vault: Vault, projectId: ProjectId, initial: GitHubState) {
    this.#vault = vault;
    this.#projectId = projectId;
    this.state = new Store(initial);
  }

  static async open(vault: Vault, projectId: ProjectId): Promise<GitHubBackup> {
    const settings = await vault.getSetting<GitHubSettings | null>(settingsKey(projectId), null);
    const hasToken = (await loadGitHubToken(vault)) !== null;
    return new GitHubBackup(vault, projectId, { status: settings && hasToken ? 'idle' : 'off', settings, hasToken, error: null, behind: false });
  }

  get connected(): boolean {
    return this.state.get().status !== 'off';
  }

  /**
   * Checks the token and the repository, stores both, and makes the first
   * backup. `token` may be null to reuse the one stored in this browser.
   */
  async connect(token: string | null, repository: string, folder: string): Promise<BackupResult | null> {
    const parsed = parseRepository(repository);
    if (!parsed) throw new Error('Write the repository as owner/name, for example anna/latex-backup.');
    const normalized = tryNormalizePath(folder);
    if (normalized === null) throw new Error('The folder name contains characters that are not allowed.');
    const usedToken = token?.trim() || (await loadGitHubToken(this.#vault));
    if (!usedToken) throw new Error('Paste a GitHub token first.');

    const info = await getRepository(new GitHubClient(usedToken), parsed);
    if (!info.canPush) throw new Error('This token may read the repository but not write to it. It needs "Contents: Read and write".');
    await saveGitHubToken(this.#vault, usedToken);
    const settings: GitHubSettings = { target: { ...parsed, folder: normalized }, auto: true, isPrivate: info.private, lastBackupAt: null, lastCommitUrl: null };
    await this.#save(settings);
    this.state.set({ status: 'idle', settings, hasToken: true, error: null, behind: true });
    return this.backupNow();
  }

  /** Stops backing up this project. The repository and its commits stay as they are. */
  async disconnect(options: { forgetToken: boolean }): Promise<void> {
    if (this.#timer) clearTimeout(this.#timer);
    await this.#vault.setSetting(settingsKey(this.#projectId), null);
    if (options.forgetToken) await saveGitHubToken(this.#vault, null);
    this.state.set({ status: 'off', settings: null, hasToken: !options.forgetToken && this.state.get().hasToken, error: null, behind: false });
  }

  async setAuto(auto: boolean): Promise<void> {
    const settings = this.state.get().settings;
    if (!settings) return;
    await this.#save({ ...settings, auto });
    this.state.patch({ settings: { ...settings, auto } });
    if (auto && this.state.get().behind) this.noteChange();
  }

  /** Tells the backup that the project changed; an automatic backup follows a while later. */
  noteChange(): void {
    const { settings, status } = this.state.get();
    if (status === 'off' || this.#disposed) return;
    this.state.patch({ behind: true });
    if (!settings?.auto) return;
    if (this.#timer) clearTimeout(this.#timer);
    const sinceLast = settings.lastBackupAt === null ? Infinity : Date.now() - settings.lastBackupAt;
    const wait = Math.max(AUTO_DELAY_MS, MIN_INTERVAL_MS - sinceLast);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.backupNow().catch(() => undefined);
    }, wait);
  }

  /** Makes a backup now. Resolves to null when the project is not connected. */
  backupNow(): Promise<BackupResult | null> {
    if (this.#running) return this.#running;
    const run = async (): Promise<BackupResult | null> => {
      const settings = this.state.get().settings;
      const token = await loadGitHubToken(this.#vault);
      if (!settings || !token) return null;
      this.state.patch({ status: 'running', error: null });
      try {
        const project = await this.#vault.requireProject(this.#projectId);
        const { files, skipped } = await collectBackupFiles(this.#vault, this.#projectId);
        const result = await backupProject(new GitHubClient(token), settings.target, files, `Backup of ${project.name}`);
        const next: GitHubSettings = { ...settings, isPrivate: result.isPrivate, lastBackupAt: Date.now(), lastCommitUrl: result.commitUrl };
        await this.#save(next);
        this.state.set({
          status: 'idle',
          settings: next,
          hasToken: true,
          error: skipped.length > 0 ? `${skipped.length === 1 ? `${skipped[0]} is` : `${skipped.length} files are`} over 50 MB and not part of the backup.` : null,
          behind: false,
        });
        return result;
      } catch (error) {
        this.state.patch({ status: 'failed', error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    };
    this.#running = run().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  /**
   * Asks GitHub again whether the repository is private, because that can be
   * changed on GitHub at any time. Asks at most every 5 seconds; a failure
   * keeps what was known, and the next backup reports it.
   */
  async checkRepository(): Promise<void> {
    const { settings, status } = this.state.get();
    if (!settings || status === 'off' || this.#disposed || Date.now() - this.#checkedAt < VISIBILITY_CHECK_MS) return;
    this.#checkedAt = Date.now();
    const token = await loadGitHubToken(this.#vault);
    if (!token) return;
    const info = await getRepository(new GitHubClient(token), settings.target).catch(() => null);
    const current = this.state.get().settings;
    if (!info || !current || this.#disposed || info.private === current.isPrivate) return;
    const next = { ...current, isPrivate: info.private };
    await this.#save(next);
    this.state.patch({ settings: next });
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#timer) clearTimeout(this.#timer);
  }

  async #save(settings: GitHubSettings): Promise<void> {
    await this.#vault.setSetting(settingsKey(this.#projectId), settings);
  }
}

/** Connects a project to a backup folder without making a backup, after it was restored from there. */
export async function adoptGitHubTarget(vault: Vault, projectId: ProjectId, target: GitHubTarget, isPrivate: boolean): Promise<void> {
  const settings: GitHubSettings = { target, auto: true, isPrivate, lastBackupAt: Date.now(), lastCommitUrl: null };
  await vault.setSetting(settingsKey(projectId), settings);
}
