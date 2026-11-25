/**
 * Keeps one project and its linked folder on disk in step, in both directions.
 *
 * The project in the browser stays the copy the editor works on. A pass lists
 * the folder, compares both sides with what they agreed on last time (see
 * `plan.ts`) and copies what changed. Passes run after saves, when the window
 * gets the focus back, on a timer, and on request.
 */
import { sha256Hex } from '../hash';
import { outputPdfPath } from '../latex/deps';
import { isWithin } from '../paths';
import { Store } from '../store';
import type { EntryKind, Hash, Millis, Path, ProjectId } from '../types';
import type { Vault } from '../vault/vault';
import {
  type DirHandle,
  type DiskEntry,
  makeDiskFolder,
  permissionOf,
  removeDiskEntry,
  requestPermission,
  scanFolder,
  writeDiskFile,
} from './disk';
import { planSync, type Stamp, type SyncAction } from './plan';

export type FolderStatus =
  | 'off' // the project is not linked
  | 'needs-permission' // linked, but the browser wants the user to allow access again
  | 'syncing'
  | 'synced'
  | 'attention' // synced, but something needs the user's eyes (see `problems`, `missing`)
  | 'error'; // the folder could not be used at all (moved, deleted, drive unplugged)

export interface FolderState {
  status: FolderStatus;
  folderName: string | null;
  lastSyncAt: Millis | null;
  /** What went wrong in the last pass, in sentences for the user. */
  problems: string[];
  /** Files that vanished from the folder in bulk; the user decides what that means. */
  missing: Path[] | null;
  /** Copies that were made in the last pass because both sides had changed a file. */
  conflicts: Path[];
  /** Changes in the project that have not reached the folder yet. */
  waiting: number;
}

/** What both sides agreed on for one path, with the disk's size and time at that moment. */
interface BaseRecord {
  kind: EntryKind;
  hash: Hash | null;
  size: number;
  mtime: number;
}

export interface FolderSyncOptions {
  /** Called before a pass changes or deletes files in the project, so a version can be saved. */
  beforeIncoming?: () => Promise<void>;
  /** Called before linking or unlinking. */
  beforeLinkChange?: () => Promise<void>;
  now?: () => Millis;
}

const OFF: FolderState = { status: 'off', folderName: null, lastSyncAt: null, problems: [], missing: null, conflicts: [], waiting: 0 };
const KEEP_BYTES_BELOW = 2 * 1024 * 1024;

function describe(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'NotFoundError') return 'it is no longer there';
    if (error.name === 'NotAllowedError') return 'the browser was not allowed to';
    if (error.name === 'NoModificationAllowedError') return 'it is write-protected or open in another program';
    if (error.name === 'QuotaExceededError') return 'the disk is full';
    return error.message;
  }
  return String(error);
}

export class FolderSync {
  readonly state: Store<FolderState>;
  readonly #vault: Vault;
  readonly #projectId: ProjectId;
  readonly #options: FolderSyncOptions;
  readonly #now: () => Millis;
  #root: DirHandle | null = null;
  #running: Promise<void> | null = null;
  #queued: { massDeletion?: 'apply' | 'restore' } | null = null;
  #output: { bytes: Uint8Array; hash: Hash } | null = null;
  #writtenOutput: Hash | null = null;
  #disposed = false;

  private constructor(vault: Vault, projectId: ProjectId, options: FolderSyncOptions, root: DirHandle | null, initial: FolderState) {
    this.#vault = vault;
    this.#projectId = projectId;
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#root = root;
    this.state = new Store(initial);
  }

  /** Loads the link of a project, if it has one. Does not touch the disk yet. */
  static async open(vault: Vault, projectId: ProjectId, options: FolderSyncOptions = {}): Promise<FolderSync> {
    const project = await vault.requireProject(projectId);
    const root = project.link ? ((await vault.loadHandle(projectId)) as unknown as DirHandle | null) : null;
    if (!project.link || !root) return new FolderSync(vault, projectId, options, null, OFF);
    const granted = (await permissionOf(root)) === 'granted';
    const waiting = await vault.countPendingMirror(projectId);
    return new FolderSync(vault, projectId, options, root, {
      ...OFF,
      status: granted ? 'synced' : 'needs-permission',
      folderName: project.link.folderName,
      lastSyncAt: project.link.lastSyncAt,
      waiting,
    });
  }

  get linked(): boolean {
    return this.#root !== null;
  }

  /**
   * Links the project to `root` and runs the first pass. Files that exist on
   * one side only are copied to the other; files that differ are kept twice.
   */
  async link(root: DirHandle): Promise<void> {
    if ((await requestPermission(root)) !== 'granted') throw new Error('The browser was not allowed to write to this folder.');
    await this.#options.beforeLinkChange?.();
    await this.#running?.catch(() => undefined);
    await this.#vault.saveHandle(this.#projectId, root as unknown as FileSystemDirectoryHandle);
    await this.#saveBase(new Map());
    await this.#vault.clearMirrorQueue(this.#projectId);
    await this.#vault.updateProject(this.#projectId, {
      link: { folderName: root.name, linkedAt: this.#now(), lastSyncAt: null, writePdf: true },
    });
    this.#root = root;
    this.#writtenOutput = null;
    this.state.set({ ...OFF, status: 'syncing', folderName: root.name });
    await this.request();
  }

  /** Ends the link. Nothing is deleted on either side. */
  async unlink(): Promise<void> {
    await this.#options.beforeLinkChange?.();
    await this.#running?.catch(() => undefined);
    this.#root = null;
    await this.#vault.forgetHandle(this.#projectId);
    await this.#vault.setSetting(this.#baseKey(), {});
    await this.#vault.clearMirrorQueue(this.#projectId);
    await this.#vault.updateProject(this.#projectId, { link: null });
    this.state.set(OFF);
  }

  /** Asks the browser for access again. Must be called from a click. */
  async reconnect(): Promise<boolean> {
    if (!this.#root) return false;
    if ((await requestPermission(this.#root)) !== 'granted') return false;
    await this.request();
    return true;
  }

  /** The compiled PDF, which is written next to the main file when the link asks for it. */
  setOutput(bytes: Uint8Array | null): void {
    if (!bytes) {
      this.#output = null;
      return;
    }
    void sha256Hex(bytes).then((hash) => {
      this.#output = { bytes, hash };
      if (hash !== this.#writtenOutput) void this.request();
    });
  }

  /**
   * Runs a pass, or makes sure one more runs after the current one. The
   * answer to the accident guard is passed as `massDeletion`.
   */
  request(options: { massDeletion?: 'apply' | 'restore' } = {}): Promise<void> {
    if (!this.#root || this.#disposed) return Promise.resolve();
    if (this.#running) {
      this.#queued = { ...this.#queued, ...options };
      return this.#running;
    }
    const run = async (first: { massDeletion?: 'apply' | 'restore' }): Promise<void> => {
      let next: { massDeletion?: 'apply' | 'restore' } | null = first;
      while (next && this.#root && !this.#disposed) {
        this.#queued = null;
        await this.#pass(next.massDeletion);
        next = this.#queued;
      }
    };
    this.#running = run(options).finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    await this.#running?.catch(() => undefined);
  }

  // ---- one pass -------------------------------------------------------------

  async #pass(massDeletion?: 'apply' | 'restore'): Promise<void> {
    const root = this.#root;
    if (!root) return;
    const previous = this.state.get();
    if ((await permissionOf(root)) !== 'granted') {
      this.state.set({ ...previous, status: 'needs-permission', waiting: await this.#vault.countPendingMirror(this.#projectId) });
      return;
    }
    this.state.set({ ...previous, status: 'syncing' });

    const problems: string[] = [];
    const conflicts: Path[] = [];
    try {
      const project = await this.#vault.requireProject(this.#projectId);
      const queueMark = (await this.#vault.pendingMirror(this.#projectId)).at(-1)?.seq ?? 0;
      const listing = await this.#vault.list(this.#projectId);
      const vaultSide = new Map<Path, Stamp>(listing.map((entry) => [entry.path, { kind: entry.kind, hash: entry.hash }]));
      const base = await this.#loadBase();
      const outputPath = project.link?.writePdf && project.mainFile ? outputPdfPath(project.mainFile) : null;
      const ownOutput = (path: Path): boolean => path === outputPath && !vaultSide.has(path);

      const scan = await scanFolder(root, (path) => vaultSide.has(path) || base.has(path), ownOutput);
      const diskSide = new Map<Path, Stamp>();
      const kept = new Map<Path, Uint8Array>();
      for (const [path, entry] of scan.entries) {
        if (entry.kind === 'dir') {
          diskSide.set(path, { kind: 'dir', hash: null });
          continue;
        }
        const known = base.get(path);
        if (known && known.kind === 'file' && known.size === entry.size && known.mtime === entry.mtime) {
          diskSide.set(path, { kind: 'file', hash: known.hash });
          continue;
        }
        const bytes = new Uint8Array(await entry.file!.arrayBuffer());
        const hash = await sha256Hex(bytes);
        diskSide.set(path, { kind: 'file', hash });
        if (known && known.hash === hash) base.set(path, { ...known, size: entry.size, mtime: entry.mtime });
        else if (bytes.byteLength <= KEEP_BYTES_BELOW) kept.set(path, bytes);
      }
      const skippedNames = scan.skipped.filter((item) => item.reason === 'name').length;
      const skippedLarge = scan.skipped.filter((item) => item.reason === 'size').length;
      if (skippedNames > 0) {
        problems.push(
          `${skippedNames === 1 ? `"${scan.skipped.find((item) => item.reason === 'name')!.path}" in the folder is` : `${skippedNames} entries in the folder are`} left out because the name contains characters that do not work on every system.`,
        );
      }
      if (skippedLarge > 0) problems.push(`${skippedLarge === 1 ? 'One file' : `${skippedLarge} files`} over 100 MB in the folder ${skippedLarge === 1 ? 'is' : 'are'} left out.`);

      const baseSide = new Map<Path, Stamp>([...base].map(([path, record]) => [path, { kind: record.kind, hash: record.hash }]));
      const plan = planSync({ vault: vaultSide, disk: diskSide, base: baseSide, massDeletion: massDeletion ?? 'ask' });
      const missing = plan.guard?.missing ?? null;

      const incoming = plan.actions.some(
        (action) => action.type === 'remove-vault' || action.type === 'conflict' || (action.type === 'to-vault' && vaultSide.has(action.path)),
      );
      if (incoming) await this.#options.beforeIncoming?.();

      for (const action of plan.actions) {
        try {
          await this.#apply(root, action, { vaultSide, diskSide, scan: scan.entries, kept, base, conflicts });
        } catch (error) {
          if (action.type === 'blocked') problems.push(action.reason);
          else problems.push(`"${action.path}" could not be ${action.type.startsWith('remove') ? 'removed' : 'copied'}: ${describe(error)}.`);
        }
      }

      await this.#saveBase(base);
      // Everything queued before this pass started is covered by it.
      for (const item of await this.#vault.pendingMirror(this.#projectId)) {
        if ((item.seq ?? 0) <= queueMark) await this.#vault.clearMirrorItem(item.seq!);
      }

      if (outputPath && this.#output && this.#output.hash !== this.#writtenOutput && !vaultSide.has(outputPath)) {
        try {
          await writeDiskFile(root, outputPath, this.#output.bytes);
          this.#writtenOutput = this.#output.hash;
        } catch (error) {
          problems.push(`The PDF could not be written to the folder: ${describe(error)}.`);
        }
      }

      const now = this.#now();
      const clean = problems.length === 0 && missing === null;
      const fresh = await this.#vault.requireProject(this.#projectId);
      if (fresh.link && clean) await this.#vault.updateProject(this.#projectId, { link: { ...fresh.link, lastSyncAt: now } });
      this.state.set({
        status: clean ? 'synced' : 'attention',
        folderName: root.name,
        lastSyncAt: clean ? now : previous.lastSyncAt,
        problems,
        missing,
        conflicts: conflicts.length > 0 ? conflicts : previous.conflicts,
        waiting: await this.#vault.countPendingMirror(this.#projectId),
      });
    } catch (error) {
      const denied = error instanceof Error && error.name === 'NotAllowedError';
      this.state.set({
        ...previous,
        status: denied ? 'needs-permission' : 'error',
        problems: denied ? [] : [`The folder could not be read: ${describe(error)}. It may have been moved, renamed or deleted.`],
        waiting: await this.#vault.countPendingMirror(this.#projectId).catch(() => previous.waiting),
      });
    }
  }

  async #apply(
    root: DirHandle,
    action: SyncAction,
    context: {
      vaultSide: Map<Path, Stamp>;
      diskSide: Map<Path, Stamp>;
      scan: Map<Path, DiskEntry>;
      kept: Map<Path, Uint8Array>;
      base: Map<Path, BaseRecord>;
      conflicts: Path[];
    },
  ): Promise<void> {
    const { vaultSide, diskSide, scan, kept, base } = context;
    const vault = this.#vault;
    const id = this.#projectId;
    const incoming = { origin: 'folder', skipMirror: true } as const;
    const folderRecord: BaseRecord = { kind: 'dir', hash: null, size: 0, mtime: 0 };

    /** True when the project file was edited after this pass listed it; the next pass will see it. */
    const changedMeanwhile = async (path: Path): Promise<boolean> => {
      const now = await vault.stat(id, path);
      const then = vaultSide.get(path);
      return (now?.hash ?? null) !== (then?.hash ?? null) || (now?.kind ?? null) !== (then?.kind ?? null);
    };
    const diskBytes = async (path: Path): Promise<Uint8Array> => kept.get(path) ?? new Uint8Array(await scan.get(path)!.file!.arrayBuffer());
    const pushFile = async (path: Path): Promise<void> => {
      const entry = await vault.stat(id, path);
      if (!entry || entry.kind !== 'file' || entry.hash === null) return;
      const stamp = await writeDiskFile(root, path, await vault.readBlob(entry.hash));
      base.set(path, { kind: 'file', hash: entry.hash, ...stamp });
    };
    const forgetUnder = (path: Path): void => {
      for (const key of [...base.keys()]) if (isWithin(key, path)) base.delete(key);
    };

    switch (action.type) {
      case 'to-disk':
        if (action.kind === 'dir') {
          await makeDiskFolder(root, action.path);
          base.set(action.path, folderRecord);
        } else await pushFile(action.path);
        return;

      case 'to-vault': {
        if (await changedMeanwhile(action.path)) return;
        if (action.kind === 'dir') {
          await vault.mkdir(id, action.path, incoming);
          base.set(action.path, folderRecord);
          return;
        }
        const entry = scan.get(action.path)!;
        await vault.writeFile(id, action.path, await diskBytes(action.path), incoming);
        base.set(action.path, { kind: 'file', hash: diskSide.get(action.path)!.hash, size: entry.size, mtime: entry.mtime });
        return;
      }

      case 'remove-disk':
        await removeDiskEntry(root, action.path);
        forgetUnder(action.path);
        return;

      case 'remove-vault':
        if (await changedMeanwhile(action.path)) return;
        if (await vault.exists(id, action.path)) await vault.remove(id, action.path, incoming);
        forgetUnder(action.path);
        return;

      case 'conflict': {
        if (await changedMeanwhile(action.path)) return;
        // The folder's version first gets its own name on both sides, then the project's version takes the path.
        const theirs = await diskBytes(action.path);
        await vault.writeFile(id, action.copyPath, theirs, incoming);
        const stamp = await writeDiskFile(root, action.copyPath, theirs);
        base.set(action.copyPath, { kind: 'file', hash: diskSide.get(action.path)!.hash, ...stamp });
        await pushFile(action.path);
        context.conflicts.push(action.copyPath);
        return;
      }

      case 'settle': {
        const side = diskSide.get(action.path)!;
        const entry = scan.get(action.path)!;
        base.set(action.path, { kind: side.kind, hash: side.hash, size: entry.size, mtime: entry.mtime });
        return;
      }

      case 'forget':
        base.delete(action.path);
        return;

      case 'blocked':
        throw new Error(action.reason);
    }
  }

  // ---- the record of the last agreement --------------------------------------

  #baseKey(): string {
    return `folder-base:${this.#projectId}`;
  }

  async #loadBase(): Promise<Map<Path, BaseRecord>> {
    const stored = await this.#vault.getSetting<Record<Path, BaseRecord>>(this.#baseKey(), {});
    return new Map(Object.entries(stored));
  }

  async #saveBase(base: Map<Path, BaseRecord>): Promise<void> {
    await this.#vault.setSetting(this.#baseKey(), Object.fromEntries(base));
  }
}
