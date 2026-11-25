/**
 * Backs a project up to a GitHub repository that the user owns, straight from
 * the browser. There is no server in between: the requests go from this page
 * to api.github.com with a personal access token that the user created and
 * that is stored in this browser only.
 *
 * A backup is one commit. Several projects can share a repository; each has
 * its own folder in it, and files outside that folder are never touched.
 */
import type { Path } from '../types';

export interface GitHubTarget {
  owner: string;
  repo: string;
  /** Folder inside the repository that holds this project; '' for the repository root. */
  folder: Path;
}

export interface RepositoryInfo {
  private: boolean;
  defaultBranch: string;
  canPush: boolean;
  htmlUrl: string;
}

export interface BackupFile {
  path: Path;
  bytes: Uint8Array;
}

export interface BackupResult {
  /** False when the repository already had exactly these files and no commit was made. */
  changed: boolean;
  commit: string;
  commitUrl: string;
  uploaded: number;
  deleted: number;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

const API = 'https://api.github.com';

/** Explains the common failures in terms of what the user can do about them. */
function explain(status: number, apiMessage: string): string {
  if (status === 401) return 'GitHub did not accept the token. It may be mistyped, expired or revoked.';
  if (status === 403 && /rate limit/i.test(apiMessage)) return 'GitHub is limiting requests right now. The backup will work again in a while.';
  if (status === 403) return 'The token is not allowed to do this. It needs "Contents: Read and write" for this repository.';
  if (status === 404) return 'GitHub cannot find this repository with this token. Check the name, and that the token includes the repository.';
  if (status === 409) return 'The repository is empty or changed while the backup ran.';
  if (status === 422) return `GitHub rejected the request: ${apiMessage}`;
  if (status >= 500) return 'GitHub is having trouble right now. Try again later.';
  return `GitHub answered with an error (${status}): ${apiMessage}`;
}

export class GitHubClient {
  readonly #token: string;
  readonly #fetch: FetchLike;

  constructor(token: string, fetchImpl?: FetchLike) {
    this.#token = token.trim();
    this.#fetch = fetchImpl ?? ((url, init) => fetch(url, { ...init, cache: 'no-store', referrerPolicy: 'no-referrer' }));
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.#fetch(`${API}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.#token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new GitHubError('GitHub could not be reached. Check the internet connection.', 0);
    }
    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as { message?: string } | null;
      throw new GitHubError(explain(response.status, detail?.message ?? ''), response.status);
    }
    return (response.status === 204 ? null : await response.json()) as T;
  }
}

const repoPath = (target: Pick<GitHubTarget, 'owner' | 'repo'>): string => `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;

/** Splits "owner/name" or a github.com address into its parts. */
export function parseRepository(input: string): { owner: string; repo: string } | null {
  const cleaned = input
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(cleaned);
  return match ? { owner: match[1]!, repo: match[2]! } : null;
}

export async function getRepository(client: GitHubClient, target: Pick<GitHubTarget, 'owner' | 'repo'>): Promise<RepositoryInfo> {
  const repo = await client.request<{ private: boolean; default_branch: string; html_url: string; permissions?: { push?: boolean } }>('GET', repoPath(target));
  return { private: repo.private, defaultBranch: repo.default_branch, canPush: repo.permissions?.push ?? false, htmlUrl: repo.html_url };
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The id git gives a file with this content, so unchanged files need no upload. */
export async function gitBlobId(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const whole = new Uint8Array(header.byteLength + bytes.byteLength);
  whole.set(header, 0);
  whole.set(bytes, header.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', whole));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

interface TreeItem {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
}

interface Head {
  branch: string;
  commit: string;
  tree: string;
  items: TreeItem[];
}

async function readHead(client: GitHubClient, target: GitHubTarget, branch: string): Promise<Head | null> {
  const base = repoPath(target);
  let commit: string;
  try {
    commit = (await client.request<{ object: { sha: string } }>('GET', `${base}/git/ref/heads/${encodeURIComponent(branch)}`)).object.sha;
  } catch (error) {
    // A repository without any commit has no branch yet.
    if (error instanceof GitHubError && (error.status === 404 || error.status === 409)) return null;
    throw error;
  }
  const tree = (await client.request<{ tree: { sha: string } }>('GET', `${base}/git/commits/${commit}`)).tree.sha;
  const listing = await client.request<{ tree: TreeItem[]; truncated: boolean }>('GET', `${base}/git/trees/${tree}?recursive=1`);
  if (listing.truncated) throw new GitHubError('This repository holds too many files for a backup from the browser. Use a repository just for backups.', 0);
  return { branch, commit, tree, items: listing.tree };
}

const inFolder = (folder: Path, path: string): boolean => folder === '' || path.startsWith(`${folder}/`);
const withFolder = (folder: Path, path: Path): string => (folder === '' ? path : `${folder}/${path}`);

/**
 * Makes the repository's folder for this project match `files`, in one
 * commit. Files that are already there with the same content are not sent
 * again; files that are gone from the project are removed from the folder.
 */
export async function backupProject(client: GitHubClient, target: GitHubTarget, files: BackupFile[], message: string): Promise<BackupResult> {
  const base = repoPath(target);
  const info = await getRepository(client, target);
  if (!info.canPush) throw new GitHubError('The token may read this repository but not write to it. It needs "Contents: Read and write".', 403);

  let head = await readHead(client, target, info.defaultBranch);
  if (!head) {
    // The low-level API refuses to work on a repository without a commit, so the first one is made the simple way.
    await client.request('PUT', `${base}/contents/README.md`, {
      message: 'Start the backup repository',
      content: toBase64(new TextEncoder().encode('# LaTeX project backups\n\nThis repository is written by the LaTeX editor. Each folder is one project.\n')),
    });
    head = await readHead(client, target, info.defaultBranch);
    if (!head) throw new GitHubError('The repository could not be prepared for the first backup.', 409);
  }

  const existing = new Map<string, string>();
  for (const item of head.items) if (item.type === 'blob' && inFolder(target.folder, item.path)) existing.set(item.path, item.sha);

  const changes: { path: string; mode: '100644'; type: 'blob'; sha: string | null }[] = [];
  const wanted = new Set<string>();
  let uploaded = 0;
  for (const file of files) {
    const path = withFolder(target.folder, file.path);
    wanted.add(path);
    const id = await gitBlobId(file.bytes);
    if (existing.get(path) === id) continue;
    const blob = await client.request<{ sha: string }>('POST', `${base}/git/blobs`, { content: toBase64(file.bytes), encoding: 'base64' });
    changes.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
    uploaded++;
  }
  let deleted = 0;
  for (const path of existing.keys()) {
    if (wanted.has(path)) continue;
    changes.push({ path, mode: '100644', type: 'blob', sha: null });
    deleted++;
  }

  const commitUrl = (sha: string): string => `${info.htmlUrl}/commit/${sha}`;
  if (changes.length === 0) return { changed: false, commit: head.commit, commitUrl: commitUrl(head.commit), uploaded: 0, deleted: 0 };

  const tree = await client.request<{ sha: string }>('POST', `${base}/git/trees`, { base_tree: head.tree, tree: changes });
  const commit = await client.request<{ sha: string }>('POST', `${base}/git/commits`, { message, tree: tree.sha, parents: [head.commit] });
  await client.request('PATCH', `${base}/git/refs/heads/${encodeURIComponent(head.branch)}`, { sha: commit.sha, force: false });
  return { changed: true, commit: commit.sha, commitUrl: commitUrl(commit.sha), uploaded, deleted };
}

/** The folders at the top of the repository, each of which may be a backed-up project. */
export async function listBackupFolders(client: GitHubClient, target: Pick<GitHubTarget, 'owner' | 'repo'>): Promise<{ folder: Path; files: number }[]> {
  const info = await getRepository(client, target);
  const head = await readHead(client, { ...target, folder: '' }, info.defaultBranch);
  if (!head) return [];
  const counts = new Map<string, number>();
  for (const item of head.items) {
    if (item.type !== 'blob' || !item.path.includes('/')) continue;
    const top = item.path.slice(0, item.path.indexOf('/'));
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  return [...counts].map(([folder, files]) => ({ folder, files })).sort((a, b) => a.folder.localeCompare(b.folder));
}

/** Downloads every file of one backed-up project. */
export async function downloadBackup(client: GitHubClient, target: GitHubTarget, onProgress?: (done: number, total: number) => void): Promise<BackupFile[]> {
  const base = repoPath(target);
  const info = await getRepository(client, target);
  const head = await readHead(client, target, info.defaultBranch);
  if (!head) return [];
  const blobs = head.items.filter((item) => item.type === 'blob' && inFolder(target.folder, item.path));
  const files: BackupFile[] = [];
  for (const item of blobs) {
    const blob = await client.request<{ content: string; encoding: string }>('GET', `${base}/git/blobs/${item.sha}`);
    const bytes = blob.encoding === 'base64' ? fromBase64(blob.content) : new TextEncoder().encode(blob.content);
    files.push({ path: target.folder === '' ? item.path : item.path.slice(target.folder.length + 1), bytes });
    onProgress?.(files.length, blobs.length);
  }
  return files;
}
