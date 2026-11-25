/**
 * A folder that lives in memory and behaves like the browser's directory
 * handles. The unit tests sync against it; the app never uses it.
 */
import type { DirHandle, DiskFile, DiskWritable, FileHandle, Permission } from './disk';

function fail(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

export interface Clock {
  now: number;
}

export class MemoryFile implements FileHandle {
  readonly kind = 'file' as const;
  bytes: Uint8Array = new Uint8Array();
  lastModified: number;

  constructor(
    readonly name: string,
    private readonly clock: Clock,
  ) {
    this.lastModified = clock.now;
  }

  getFile(): Promise<DiskFile> {
    const bytes = this.bytes;
    return Promise.resolve({
      size: bytes.byteLength,
      lastModified: this.lastModified,
      arrayBuffer: () => Promise.resolve(bytes.slice().buffer as ArrayBuffer),
    });
  }

  createWritable(): Promise<DiskWritable> {
    let pending: Uint8Array = new Uint8Array();
    return Promise.resolve({
      write: (data: Uint8Array) => {
        pending = data.slice();
        return Promise.resolve();
      },
      close: () => {
        this.bytes = pending;
        this.lastModified = ++this.clock.now;
        return Promise.resolve();
      },
    });
  }
}

export class MemoryFolder implements DirHandle {
  readonly kind = 'directory' as const;
  readonly children = new Map<string, MemoryFolder | MemoryFile>();
  permission: Permission = 'granted';
  /** What `requestPermission` answers, as if the user clicked. */
  answer: Permission = 'granted';

  constructor(
    readonly name: string,
    readonly clock: Clock = { now: 1_000 },
  ) {}

  async *entries(): AsyncGenerator<[string, MemoryFolder | MemoryFile]> {
    this.#check();
    for (const entry of [...this.children]) yield entry;
  }

  getDirectoryHandle(name: string, options: { create?: boolean } = {}): Promise<MemoryFolder> {
    this.#check();
    let child = this.children.get(name);
    if (!child) {
      if (!options.create) return Promise.reject(fail('NotFoundError', `No folder ${name}`));
      child = new MemoryFolder(name, this.clock);
      child.permission = this.permission;
      this.children.set(name, child);
    }
    if (child.kind !== 'directory') return Promise.reject(fail('TypeMismatchError', `${name} is a file`));
    return Promise.resolve(child);
  }

  getFileHandle(name: string, options: { create?: boolean } = {}): Promise<MemoryFile> {
    this.#check();
    let child = this.children.get(name);
    if (!child) {
      if (!options.create) return Promise.reject(fail('NotFoundError', `No file ${name}`));
      child = new MemoryFile(name, this.clock);
      this.children.set(name, child);
    }
    if (child.kind !== 'file') return Promise.reject(fail('TypeMismatchError', `${name} is a folder`));
    return Promise.resolve(child);
  }

  removeEntry(name: string, options: { recursive?: boolean } = {}): Promise<void> {
    this.#check();
    const child = this.children.get(name);
    if (!child) return Promise.reject(fail('NotFoundError', `No entry ${name}`));
    if (child.kind === 'directory' && child.children.size > 0 && !options.recursive) {
      return Promise.reject(fail('InvalidModificationError', `${name} is not empty`));
    }
    this.children.delete(name);
    return Promise.resolve();
  }

  queryPermission(): Promise<Permission> {
    return Promise.resolve(this.permission);
  }

  requestPermission(): Promise<Permission> {
    this.permission = this.answer;
    return Promise.resolve(this.permission);
  }

  // ---- helpers for tests, as if another program changed the folder ----------

  put(path: string, text: string): void {
    const parts = path.split('/');
    let dir = this.#self();
    for (const part of parts.slice(0, -1)) {
      let next = dir.children.get(part);
      if (!next) {
        next = new MemoryFolder(part, this.clock);
        dir.children.set(part, next);
      }
      dir = next as MemoryFolder;
    }
    const name = parts.at(-1)!;
    let file = dir.children.get(name);
    if (!file || file.kind !== 'file') {
      file = new MemoryFile(name, this.clock);
      dir.children.set(name, file);
    }
    file.bytes = new TextEncoder().encode(text);
    file.lastModified = ++this.clock.now;
  }

  mkdir(path: string): void {
    let dir = this.#self();
    for (const part of path.split('/')) {
      let next = dir.children.get(part);
      if (!next) {
        next = new MemoryFolder(part, this.clock);
        dir.children.set(part, next);
      }
      dir = next as MemoryFolder;
    }
  }

  delete(path: string): void {
    const parts = path.split('/');
    let dir = this.#self();
    for (const part of parts.slice(0, -1)) dir = dir.children.get(part) as MemoryFolder;
    dir.children.delete(parts.at(-1)!);
  }

  text(path: string): string | undefined {
    let node: MemoryFolder | MemoryFile | undefined = this.#self();
    for (const part of path.split('/')) node = node?.kind === 'directory' ? node.children.get(part) : undefined;
    return node?.kind === 'file' ? new TextDecoder().decode(node.bytes) : undefined;
  }

  /** Every path in the folder, folders with a trailing slash, sorted. */
  list(): string[] {
    const out: string[] = [];
    const walk = (dir: MemoryFolder, prefix: string): void => {
      for (const [name, child] of dir.children) {
        if (child.kind === 'directory') {
          out.push(`${prefix}${name}/`);
          walk(child, `${prefix}${name}/`);
        } else out.push(`${prefix}${name}`);
      }
    };
    walk(this, '');
    return out.sort();
  }

  #self(): MemoryFolder {
    return this;
  }

  #check(): void {
    if (this.permission !== 'granted') throw fail('NotAllowedError', 'Permission was not granted');
  }
}
