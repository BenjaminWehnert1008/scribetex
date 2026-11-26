/**
 * A stand-in for the part of GitHub's API that the backup uses, held in
 * memory. The unit tests and the browser tests talk to it instead of GitHub;
 * the app never loads this file.
 */
import { type FetchLike, gitBlobId } from './backup';

export class FakeGitHub {
  blobs = new Map<string, Uint8Array>();
  trees = new Map<string, Map<string, string>>();
  commits = new Map<string, { tree: string; parents: string[]; message: string }>();
  head: string | null = null;
  canPush = true;
  isPrivate = true;
  token = 'good-token';
  log: string[] = [];
  #counter = 0;

  fetch: FetchLike = async (url, init) => {
    const path = url.replace('https://api.github.com', '');
    this.log.push(`${init.method} ${path}`);
    const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
    if (init.headers.Authorization !== `Bearer ${this.token}`) return reply(401, { message: 'Bad credentials' });
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const match = /^\/repos\/me\/backups(\/.*)?$/.exec(path);
    if (!match) return reply(404, { message: 'Not Found' });
    const rest = match[1] ?? '';

    if (rest === '' && init.method === 'GET') {
      return reply(200, { private: this.isPrivate, default_branch: 'main', html_url: 'https://github.com/me/backups', permissions: { push: this.canPush } });
    }
    if (rest === '/git/ref/heads/main' && init.method === 'GET') {
      return this.head ? reply(200, { object: { sha: this.head } }) : reply(409, { message: 'Git Repository is empty.' });
    }
    if (rest === '/contents/README.md' && init.method === 'PUT') {
      const blob = await this.#addBlob(Uint8Array.from(atob(body.content as string), (char) => char.charCodeAt(0)));
      this.head = this.#addCommit(this.#addTree(new Map([['README.md', blob]])), [], body.message as string);
      return reply(201, {});
    }
    let found: RegExpExecArray | null;
    if ((found = /^\/git\/commits\/(\w+)$/.exec(rest)) && init.method === 'GET') {
      return reply(200, { tree: { sha: this.commits.get(found[1]!)!.tree } });
    }
    if ((found = /^\/git\/trees\/(\w+)\?recursive=1$/.exec(rest)) && init.method === 'GET') {
      const files = this.trees.get(found[1]!)!;
      const folders = new Set<string>();
      for (const file of files.keys()) file.split('/').slice(0, -1).forEach((_, index, parts) => folders.add(parts.slice(0, index + 1).join('/')));
      return reply(200, {
        truncated: false,
        tree: [
          ...[...folders].map((folder) => ({ path: folder, mode: '040000', type: 'tree', sha: `t-${folder}` })),
          ...[...files].map(([file, sha]) => ({ path: file, mode: '100644', type: 'blob', sha })),
        ],
      });
    }
    if ((found = /^\/git\/blobs\/(\w+)$/.exec(rest)) && init.method === 'GET') {
      const bytes = this.blobs.get(found[1]!)!;
      return reply(200, { encoding: 'base64', content: btoa(String.fromCharCode(...bytes)).replace(/(.{20})/g, '$1\n') });
    }
    if (rest === '/git/blobs' && init.method === 'POST') {
      if (this.head === null) return reply(409, { message: 'Git Repository is empty.' });
      return reply(201, { sha: await this.#addBlob(Uint8Array.from(atob(body.content as string), (char) => char.charCodeAt(0))) });
    }
    if (rest === '/git/trees' && init.method === 'POST') {
      const files = new Map(this.trees.get(body.base_tree as string));
      for (const change of body.tree as { path: string; sha: string | null }[]) {
        if (change.sha === null) files.delete(change.path);
        else files.set(change.path, change.sha);
      }
      return reply(201, { sha: this.#addTree(files) });
    }
    if (rest === '/git/commits' && init.method === 'POST') {
      return reply(201, { sha: this.#addCommit(body.tree as string, body.parents as string[], body.message as string) });
    }
    if (rest === '/git/refs/heads/main' && init.method === 'PATCH') {
      const parents = this.commits.get(body.sha as string)!.parents;
      if (!parents.includes(this.head!)) return reply(422, { message: 'Update is not a fast forward' });
      this.head = body.sha as string;
      return reply(200, {});
    }
    return reply(404, { message: 'Not Found' });
  };

  /** The files at the head of the repository, as text. */
  files(): Record<string, string> {
    if (!this.head) return {};
    const tree = this.trees.get(this.commits.get(this.head)!.tree)!;
    return Object.fromEntries([...tree].sort().map(([path, sha]) => [path, new TextDecoder().decode(this.blobs.get(sha))]));
  }

  commitCount(): number {
    let count = 0;
    for (let sha = this.head; sha; sha = this.commits.get(sha)!.parents[0] ?? null) count++;
    return count;
  }

  async #addBlob(bytes: Uint8Array): Promise<string> {
    const sha = await gitBlobId(bytes);
    this.blobs.set(sha, bytes);
    return sha;
  }

  #addTree(files: Map<string, string>): string {
    const sha = `tree${++this.#counter}`;
    this.trees.set(sha, files);
    return sha;
  }

  #addCommit(tree: string, parents: string[], message: string): string {
    const sha = `commit${++this.#counter}`;
    this.commits.set(sha, { tree, parents, message });
    return sha;
  }
}
