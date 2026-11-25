/**
 * Everything the workspace screen shows and does for one open project.
 * The React components subscribe to its stores and call its methods; none of
 * them talks to the vault or the engine directly.
 */
import type { SnapshotStore } from '@/core/backup/snapshots';
import { exportProjectZip } from '@/core/backup/zip';
import { CompileController } from '@/core/engine/compile';
import type { EngineClient } from '@/core/engine/types';
import type { DirHandle } from '@/core/fsa/disk';
import { FolderSync } from '@/core/fsa/sync';
import { outputPdfPath } from '@/core/latex/deps';
import { basename, dirname, extname, joinPath, tryNormalizePath, validateName } from '@/core/paths';
import type { Journal } from '@/core/session/journal';
import { acquireProjectLock, type ProjectLock } from '@/core/session/lock';
import { ProjectSession } from '@/core/session/session';
import { Emitter, Store } from '@/core/store';
import type { FileEntry, Path, ProjectId, ProjectMeta, VaultChange } from '@/core/types';
import type { Vault } from '@/core/vault/vault';

export type TabKind = 'text' | 'image' | 'pdf' | 'binary';
export type SidePanel = 'files' | 'outline' | 'history' | 'storage';

export interface Tab {
  path: Path;
  kind: TabKind;
}

export interface WorkspaceState {
  project: ProjectMeta;
  entries: FileEntry[];
  tabs: Tab[];
  active: Path | null;
  /** True when another tab holds this project. Editing is off. */
  readOnly: boolean;
  panel: SidePanel;
  bottomOpen: boolean;
  bottomTab: 'problems' | 'log';
  /** Increases whenever open buffers were replaced from the vault, so editors reload their text. */
  buffersVersion: number;
}

export interface Reveal {
  path: Path;
  line: number;
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp']);
const SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;
const AUTO_COMPILE_DELAY_MS = 900;
const FOLDER_SYNC_DELAY_MS = 700;
const FOLDER_POLL_MS = 20_000;

export function tabKindOf(entry: FileEntry): TabKind {
  const ext = extname(entry.path).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  return entry.text ? 'text' : 'binary';
}

export interface WorkspaceDeps {
  vault: Vault;
  snapshots: SnapshotStore;
  engine: EngineClient;
  journal: Journal;
}

export class WorkspaceModel {
  readonly state: Store<WorkspaceState>;
  readonly session: ProjectSession;
  readonly compile: CompileController;
  /** The link to a folder on disk; its state is 'off' when the project has none. */
  readonly folder: FolderSync;
  readonly reveal = new Emitter<Reveal>();
  /** Paths recovered from the crash journal when the project was opened. */
  readonly recovered: Path[];
  readonly projectId: ProjectId;
  readonly #deps: WorkspaceDeps;
  readonly #disposers: (() => void)[] = [];
  #lock: ProjectLock;
  #compileTimer: ReturnType<typeof setTimeout> | null = null;
  #folderTimer: ReturnType<typeof setTimeout> | null = null;
  #refreshQueued = false;
  #sentPdfVersion = 0;
  #changedSinceSnapshot = false;
  #disposed = false;

  private constructor(
    deps: WorkspaceDeps,
    project: ProjectMeta,
    entries: FileEntry[],
    lock: ProjectLock,
    recovered: Path[],
    session: ProjectSession,
    folder: FolderSync,
  ) {
    this.#deps = deps;
    this.folder = folder;
    this.projectId = project.id;
    this.#lock = lock;
    this.recovered = recovered;
    this.session = session;
    this.compile = new CompileController(deps.vault, deps.engine, project.id);
    this.state = new Store<WorkspaceState>({
      project,
      entries,
      tabs: [],
      active: null,
      readOnly: !lock.held,
      panel: 'files',
      bottomOpen: false,
      bottomTab: 'problems',
      buffersVersion: 0,
    });
    this.#wire();
  }

  static async open(deps: WorkspaceDeps, projectId: ProjectId): Promise<WorkspaceModel> {
    await deps.vault.requireProject(projectId);
    const lock = await acquireProjectLock(projectId);
    const session = new ProjectSession(deps.vault, projectId, { journal: deps.journal });
    // Only the tab that may edit replays the journal, so two tabs never both apply it.
    const recovered = lock.held ? await session.recover() : [];
    await deps.vault.updateProject(projectId, { lastOpenedAt: Date.now() });
    const entries = await deps.vault.list(projectId);
    const folder = await FolderSync.open(deps.vault, projectId, {
      beforeIncoming: async () => {
        await deps.snapshots.create(projectId, { reason: 'before-folder-pull', skipIfUnchanged: true });
      },
      beforeLinkChange: async () => {
        await deps.snapshots.create(projectId, { reason: 'before-link', skipIfUnchanged: true });
      },
    });
    const model = new WorkspaceModel(deps, await deps.vault.requireProject(projectId), entries, lock, recovered, session, folder);

    if (lock.held) {
      void deps.snapshots.create(projectId, { reason: 'auto', skipIfUnchanged: true }).catch(() => undefined);
    }
    const first = model.#initialFile();
    if (first) await model.openFile(first);
    void model.compile.request();
    void model.syncFolder();
    return model;
  }

  // ---- reading -------------------------------------------------------------

  entry(path: Path): FileEntry | undefined {
    return this.state.get().entries.find((entry) => entry.path === path);
  }

  /** The main file in effect: the chosen one, or the one the compiler detected. */
  mainFile(): Path | null {
    return this.state.get().project.mainFile ?? this.compile.state.get().mainFile;
  }

  async readBytes(path: Path): Promise<Uint8Array> {
    return this.#deps.vault.readBytes(this.projectId, path);
  }

  // ---- tabs ----------------------------------------------------------------

  async openFile(path: Path, line?: number): Promise<void> {
    const entry = this.entry(path) ?? (await this.#deps.vault.stat(this.projectId, path));
    if (!entry || entry.kind !== 'file') return;
    const kind = tabKindOf(entry);
    if (kind === 'text') await this.session.open(path);
    this.state.set((state) => ({
      ...state,
      tabs: state.tabs.some((tab) => tab.path === path) ? state.tabs : [...state.tabs, { path, kind }],
      active: path,
    }));
    if (line !== undefined) queueMicrotask(() => this.reveal.emit({ path, line }));
  }

  async closeTab(path: Path): Promise<void> {
    await this.session.close(path).catch(() => undefined);
    this.state.set((state) => {
      const index = state.tabs.findIndex((tab) => tab.path === path);
      const tabs = state.tabs.filter((tab) => tab.path !== path);
      const active = state.active === path ? (tabs[Math.min(index, tabs.length - 1)]?.path ?? null) : state.active;
      return { ...state, tabs, active };
    });
  }

  setActive(path: Path): void {
    this.state.patch({ active: path });
  }

  setPanel(panel: SidePanel): void {
    this.state.patch({ panel });
  }

  setBottom(open: boolean, tab?: 'problems' | 'log'): void {
    this.state.patch({ bottomOpen: open, ...(tab ? { bottomTab: tab } : {}) });
  }

  // ---- editing -------------------------------------------------------------

  edit(path: Path, text: string): void {
    if (this.state.get().readOnly) return;
    this.session.edit(path, text);
  }

  // ---- file tree actions ---------------------------------------------------

  /** Returns why a name cannot be used in `dir`, or null when it is fine. */
  nameProblem(dir: Path, name: string, ignore?: Path): string | null {
    const problem = validateName(name);
    if (problem) return problem;
    const target = joinPath(dir, name).toLowerCase();
    const clash = this.state.get().entries.some((entry) => entry.path.toLowerCase() === target && entry.path !== ignore);
    return clash ? 'Something with this name already exists here.' : null;
  }

  async createFile(dir: Path, name: string): Promise<Path> {
    this.#assertEditable();
    const path = joinPath(dir, name);
    await this.#deps.vault.writeText(this.projectId, path, '', { origin: 'ui' });
    await this.#refresh();
    await this.openFile(path);
    return path;
  }

  async createFolder(dir: Path, name: string): Promise<Path> {
    this.#assertEditable();
    const path = joinPath(dir, name);
    await this.#deps.vault.mkdir(this.projectId, path, { origin: 'ui' });
    await this.#refresh();
    return path;
  }

  async rename(path: Path, newName: string): Promise<Path> {
    this.#assertEditable();
    if (basename(path) === newName) return path;
    await this.session.flush();
    const to = await this.#deps.vault.rename(this.projectId, path, newName, { origin: 'ui' });
    await this.#followMove(path, to);
    return to;
  }

  async move(path: Path, toDir: Path): Promise<Path> {
    this.#assertEditable();
    const to = joinPath(toDir, basename(path));
    if (to === path || dirname(path) === toDir) return path;
    if (toDir === path || toDir.startsWith(`${path}/`)) throw new Error('A folder cannot be moved into itself.');
    await this.session.flush();
    await this.#deps.vault.move(this.projectId, path, to, { origin: 'ui' });
    await this.#followMove(path, to);
    return to;
  }

  async remove(path: Path): Promise<void> {
    this.#assertEditable();
    await this.session.flush();
    // A snapshot first, so a deleted folder can be brought back from History.
    await this.#deps.snapshots.create(this.projectId, { reason: 'before-delete', skipIfUnchanged: true });
    const removed = await this.#deps.vault.remove(this.projectId, path, { origin: 'ui' });
    const gone = new Set(removed);
    this.session.removed(removed);
    const project = this.state.get().project;
    if (project.mainFile && gone.has(project.mainFile)) await this.updateProject({ mainFile: null });
    this.state.set((state) => {
      const tabs = state.tabs.filter((tab) => !gone.has(tab.path));
      return { ...state, tabs, active: state.active && gone.has(state.active) ? (tabs.at(-1)?.path ?? null) : state.active };
    });
    await this.#refresh();
    this.#scheduleCompile();
  }

  /**
   * Adds files from outside. A name may be a relative path ("figures/plot.pdf"),
   * as it is when a whole folder was dropped; the folders are created as needed.
   * Nothing is overwritten: a name that is taken gets a number appended.
   */
  async upload(dir: Path, files: { name: string; bytes: Uint8Array }[]): Promise<{ written: Path[]; skipped: string[] }> {
    this.#assertEditable();
    const written: Path[] = [];
    const skipped: string[] = [];
    for (const file of files) {
      const relative = tryNormalizePath(file.name);
      if (relative === null || relative === '') {
        skipped.push(file.name);
        continue;
      }
      const targetDir = joinPath(dir, dirname(relative));
      const name = await this.#deps.vault.suggestName(this.projectId, targetDir, basename(relative));
      const path = joinPath(targetDir, name);
      await this.#deps.vault.writeFile(this.projectId, path, file.bytes, { origin: 'ui' });
      written.push(path);
    }
    await this.#refresh();
    this.#scheduleCompile();
    return { written, skipped };
  }

  async updateProject(patch: Partial<Omit<ProjectMeta, 'id'>>): Promise<void> {
    const project = await this.#deps.vault.updateProject(this.projectId, patch);
    this.state.patch({ project });
    if ('mainFile' in patch || 'engine' in patch) this.#scheduleCompile();
  }

  // ---- compile, export, history ---------------------------------------------

  async compileNow(): Promise<void> {
    await this.session.flush().catch(() => undefined);
    await this.compile.request();
  }

  async exportZip(): Promise<{ name: string; bytes: Uint8Array }> {
    await this.session.flush();
    const { pdf, mainFile } = this.compile.state.get();
    const extra = pdf && mainFile ? [{ path: outputPdfPath(mainFile), bytes: pdf }] : [];
    const bytes = await exportProjectZip(this.#deps.vault, this.projectId, { extra });
    await this.updateProject({ lastExportAt: Date.now() });
    return { name: `${safeFileName(this.state.get().project.name)}.zip`, bytes };
  }

  async snapshotNow(label: string | null): Promise<void> {
    await this.session.flush();
    await this.#deps.snapshots.create(this.projectId, { reason: 'manual', label });
  }

  async restoreSnapshot(id: string): Promise<void> {
    this.#assertEditable();
    await this.session.flush();
    await this.#deps.snapshots.restore(id);
  }

  // ---- linked folder ---------------------------------------------------------

  /** Links the project to a folder that the user picked, and syncs for the first time. */
  async linkFolder(root: DirHandle): Promise<void> {
    this.#assertEditable();
    await this.session.flush();
    await this.folder.link(root);
    this.folder.setOutput(this.compile.state.get().pdf);
  }

  async unlinkFolder(): Promise<void> {
    this.#assertEditable();
    await this.folder.unlink();
  }

  /**
   * Brings the project and its folder in step now. Only the tab that may edit
   * does this; two tabs writing the same folder would undo each other.
   */
  async syncFolder(options: { massDeletion?: 'apply' | 'restore' } = {}): Promise<void> {
    if (!this.folder.linked || this.state.get().readOnly || this.#disposed) return;
    await this.session.flush().catch(() => undefined);
    await this.folder.request(options);
  }

  /** Takes the project over from another tab. */
  async takeOver(): Promise<void> {
    this.#lock.release();
    this.#lock = await acquireProjectLock(this.projectId, { steal: true });
    this.#watchLock();
    await this.#reloadBuffers();
    this.state.patch({ readOnly: !this.#lock.held });
    void this.syncFolder();
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#compileTimer) clearTimeout(this.#compileTimer);
    if (this.#folderTimer) clearTimeout(this.#folderTimer);
    for (const dispose of this.#disposers) dispose();
    this.compile.dispose();
    await this.session.dispose();
    // One last pass, so the folder has what was typed before the project closed.
    if (this.folder.linked && this.#lock.held) await this.folder.request().catch(() => undefined);
    await this.folder.dispose();
    if (this.#changedSinceSnapshot && this.#lock.held) {
      await this.#deps.snapshots.create(this.projectId, { reason: 'auto', skipIfUnchanged: true }).catch(() => undefined);
    }
    this.#lock.release();
  }

  // ---- internals -----------------------------------------------------------

  #wire(): void {
    this.#disposers.push(
      this.#deps.vault.changes.on((change) => this.#onVaultChange(change)),
      this.session.saved.on(() => {
        this.#changedSinceSnapshot = true;
        this.#scheduleCompile();
        this.#scheduleFolderSync();
      }),
      // A new PDF is written to the linked folder, next to the main file.
      this.compile.state.subscribe(() => {
        const { pdf, pdfVersion } = this.compile.state.get();
        if (pdfVersion === this.#sentPdfVersion) return;
        this.#sentPdfVersion = pdfVersion;
        if (this.folder.linked && !this.state.get().readOnly) this.folder.setOutput(pdf);
      }),
    );
    const poll = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') void this.syncFolder();
    }, FOLDER_POLL_MS);
    this.#disposers.push(() => clearInterval(poll));
    const timer = setInterval(() => void this.#autoSnapshot(), SNAPSHOT_INTERVAL_MS);
    this.#disposers.push(() => clearInterval(timer));
    this.#watchLock();

    if (typeof document !== 'undefined') {
      const onHide = (): void => {
        if (document.visibilityState === 'hidden') this.session.suspend();
        // Coming back from another program is when the folder most likely changed.
        else void this.syncFolder();
      };
      const onFocus = (): void => void this.syncFolder();
      window.addEventListener('focus', onFocus);
      this.#disposers.push(() => window.removeEventListener('focus', onFocus));
      const onPageHide = (): void => this.session.suspend();
      document.addEventListener('visibilitychange', onHide);
      window.addEventListener('pagehide', onPageHide);
      this.#disposers.push(() => {
        document.removeEventListener('visibilitychange', onHide);
        window.removeEventListener('pagehide', onPageHide);
      });
    }
  }

  #watchLock(): void {
    this.#lock.onLost(() => {
      // Another tab took over. Stop editing here; that tab now owns the files.
      this.state.patch({ readOnly: true });
    });
  }

  #onVaultChange(change: VaultChange): void {
    if (change.projectId !== this.projectId || this.#disposed) return;
    if (change.type === 'project') {
      if (change.project) this.state.patch({ project: change.project });
      return;
    }
    const outside = change.origin === 'folder' || change.origin === 'restore' || change.origin === 'import';
    if (!this.#refreshQueued) {
      this.#refreshQueued = true;
      queueMicrotask(() => {
        this.#refreshQueued = false;
        void this.#refresh().then(() => (outside ? this.#reloadBuffers() : undefined));
      });
    }
    if (outside) {
      this.#changedSinceSnapshot = true;
      this.#scheduleCompile();
    }
    if (change.origin !== 'folder') this.#scheduleFolderSync();
  }

  async #refresh(): Promise<void> {
    if (this.#disposed) return;
    const entries = await this.#deps.vault.list(this.projectId);
    this.state.patch({ entries });
  }

  /** Re-reads open buffers after files changed underneath them, and closes tabs of files that are gone. */
  async #reloadBuffers(): Promise<void> {
    const state = this.state.get();
    const existing = new Set(state.entries.filter((entry) => entry.kind === 'file').map((entry) => entry.path));
    const gone = state.tabs.filter((tab) => !existing.has(tab.path)).map((tab) => tab.path);
    this.session.removed(gone);
    for (const tab of state.tabs) {
      if (tab.kind === 'text' && existing.has(tab.path)) await this.session.reload(tab.path);
    }
    this.state.set((current) => {
      const tabs = current.tabs.filter((tab) => existing.has(tab.path));
      const active = current.active && existing.has(current.active) ? current.active : (tabs.at(-1)?.path ?? null);
      return { ...current, tabs, active, buffersVersion: current.buffersVersion + 1 };
    });
  }

  async #followMove(from: Path, to: Path): Promise<void> {
    this.session.renamed(from, to);
    const remap = (path: Path): Path => (path === from || path.startsWith(`${from}/`) ? to + path.slice(from.length) : path);
    const project = this.state.get().project;
    if (project.mainFile && remap(project.mainFile) !== project.mainFile) {
      await this.updateProject({ mainFile: remap(project.mainFile) });
    }
    this.state.set((state) => ({
      ...state,
      tabs: state.tabs.map((tab) => ({ ...tab, path: remap(tab.path) })),
      active: state.active ? remap(state.active) : null,
    }));
    await this.#refresh();
    this.#scheduleCompile();
  }

  #scheduleCompile(): void {
    if (!this.state.get().project.autoCompile || this.#disposed) return;
    if (this.#compileTimer) clearTimeout(this.#compileTimer);
    this.#compileTimer = setTimeout(() => {
      this.#compileTimer = null;
      void this.compile.request();
    }, AUTO_COMPILE_DELAY_MS);
  }

  #scheduleFolderSync(): void {
    if (!this.folder.linked || this.#disposed) return;
    if (this.#folderTimer) clearTimeout(this.#folderTimer);
    this.#folderTimer = setTimeout(() => {
      this.#folderTimer = null;
      void this.syncFolder();
    }, FOLDER_SYNC_DELAY_MS);
  }

  async #autoSnapshot(): Promise<void> {
    if (!this.#changedSinceSnapshot || !this.#lock.held || this.#disposed) return;
    this.#changedSinceSnapshot = false;
    try {
      await this.session.flush();
      await this.#deps.snapshots.create(this.projectId, { reason: 'auto', skipIfUnchanged: true });
      await this.#deps.snapshots.prune(this.projectId);
    } catch {
      this.#changedSinceSnapshot = true;
    }
  }

  #initialFile(): Path | null {
    const { project, entries } = this.state.get();
    if (project.mainFile && entries.some((entry) => entry.path === project.mainFile)) return project.mainFile;
    const texFiles = entries.filter((entry) => entry.kind === 'file' && extname(entry.path) === '.tex');
    return (texFiles.find((entry) => basename(entry.path) === 'main.tex') ?? texFiles.sort((a, b) => a.path.split('/').length - b.path.split('/').length)[0])?.path ?? null;
  }

  #assertEditable(): void {
    if (this.state.get().readOnly) throw new Error('This project is open for editing in another tab.');
  }
}

export function safeFileName(name: string): string {
  // Control characters are exactly what must not end up in a file name.
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().replace(/\s+/g, ' ');
  return cleaned === '' ? 'project' : cleaned;
}
