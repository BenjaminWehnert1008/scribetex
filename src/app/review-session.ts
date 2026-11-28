/**
 * Comments and suggestions of one open project.
 *
 * Owns the two review documents (the source mirror and the threads), keeps
 * them stored, keeps the mirror in step with every change to the files, and
 * tells the interface where each thread is now. Making review files and
 * reading them back is done here too.
 *
 * Review is switched on for a project by its first comment or its first
 * review copy. Until then nothing of this runs, so projects without comments
 * work exactly as before.
 */
import { isBuildArtifact } from '@/core/latex/deps';
import { type SourceRange, SourceMirror } from '@/core/review/mirror';
import { type CommentsFile, REVIEW_EXTENSION, type ReviewCopy, writeComments, writeReviewCopy } from '@/core/review/package';
import { type MergeSummary, ReviewDoc } from '@/core/review/review-doc';
import { DocPersistence, type ReviewStorage } from '@/core/review/storage';
import type { TextChange } from '@/core/review/text-diff';
import type { PdfHint, Person, Thread } from '@/core/review/types';
import { Emitter, Store } from '@/core/store';
import type { Path, ProjectId, VaultChange } from '@/core/types';
import type { Vault } from '@/core/vault/vault';
import { loadMe, saveMe } from './identity';

export type ReviewMode = 'edit' | 'comment' | 'suggest';
export type ReviewRole = 'author' | 'reviewer';

export interface ResolvedThread extends Thread {
  /** Where the thread is in the source now; null when it is not tied to the source. */
  at: SourceRange | null;
  /** The source text it is about is no longer what it was when the thread was made. */
  changed: boolean;
  /** That text was deleted. */
  gone: boolean;
}

export interface ReviewState {
  /** Review has been switched on for this project. */
  active: boolean;
  role: ReviewRole;
  me: Person | null;
  mode: ReviewMode;
  threads: ResolvedThread[];
  selected: string | null;
  /** Increases whenever thread positions were worked out again. */
  version: number;
}

export interface ReviewHost {
  projectId: ProjectId;
  vault: Vault;
  storage: ReviewStorage;
  /** The text of a file as the editor has it, unsaved typing included. */
  readText(path: Path): Promise<string>;
  /** Changes a file, through the editor when it is open there, so the change can be undone. */
  applyEdit(path: Path, change: TextChange): Promise<void>;
  /** This tab may change the project (it holds the editing lock). */
  canWrite(): boolean;
}

/** Thrown when an action needs the person's name first. */
export class NeedNameError extends Error {
  constructor() {
    super('Tell us your name first, so others know who wrote the comment.');
    this.name = 'NeedNameError';
  }
}

const MAX_TEXT_BYTES = 2 * 1024 * 1024;

export class ReviewSession {
  readonly state: Store<ReviewState>;
  /** Asks the interface to show a thread in the source and the PDF. */
  readonly focus = new Emitter<{ id: string; from: 'panel' | 'source' | 'pdf' }>();
  readonly #host: ReviewHost;
  #mirror: SourceMirror;
  #doc: ReviewDoc;
  #mirrorStore: DocPersistence;
  #reviewStore: DocPersistence;
  readonly #disposers: (() => void)[] = [];
  #resolveTimer: ReturnType<typeof setTimeout> | null = null;
  #reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  #disposed = false;

  private constructor(host: ReviewHost, role: ReviewRole, me: Person | null) {
    this.#host = host;
    this.#mirror = new SourceMirror();
    this.#doc = new ReviewDoc();
    this.#mirrorStore = new DocPersistence(host.storage, host.projectId, 'mirror', this.#mirror.doc, { delayMs: 800 });
    this.#reviewStore = new DocPersistence(host.storage, host.projectId, 'review', this.#doc.doc);
    this.state = new Store<ReviewState>({ active: false, role, me, mode: role === 'reviewer' ? 'comment' : 'edit', threads: [], selected: null, version: 0 });
  }

  static async open(host: ReviewHost, role: ReviewRole): Promise<ReviewSession> {
    const session = new ReviewSession(host, role, await loadMe(host.vault));
    await session.#load();
    session.#disposers.push(host.vault.changes.on((change) => session.#onVaultChange(change)));
    return session;
  }

  get mirror(): SourceMirror {
    return this.#mirror;
  }

  get doc(): ReviewDoc {
    return this.#doc;
  }

  // ---- state ------------------------------------------------------------------

  setMode(mode: ReviewMode): void {
    if (this.state.get().role === 'reviewer' && mode === 'edit') return;
    this.state.patch({ mode });
  }

  select(id: string | null, from: 'panel' | 'source' | 'pdf' = 'panel'): void {
    this.state.patch({ selected: id });
    if (id) this.focus.emit({ id, from });
  }

  async setMe(name: string, color?: number): Promise<Person> {
    const me = await saveMe(this.#host.vault, name, color);
    this.state.patch({ me });
    return me;
  }

  thread(id: string): ResolvedThread | null {
    return this.state.get().threads.find((thread) => thread.id === id) ?? null;
  }

  // ---- making threads ------------------------------------------------------------

  /** A comment on a range of the source, or, when `path` is null, on a spot of the PDF only. */
  async comment(input: { path: Path | null; from: number; to: number; body: string; pdf?: PdfHint | null }): Promise<string> {
    const me = this.#requireMe();
    await this.activate();
    const target = input.path ? this.#target(input.path, input.from, input.to) : null;
    return this.#doc.add({
      kind: 'comment',
      anchor: target?.anchor ?? null,
      path: input.path,
      quote: target?.quote ?? input.pdf?.text ?? '',
      replacement: null,
      plain: null,
      body: input.body.trim(),
      author: me,
      pdf: input.pdf ?? null,
    });
  }

  /** A suggestion to replace a range of the source (an empty range inserts). */
  async suggest(input: { path: Path; from: number; to: number; replacement: string; body?: string; pdf?: PdfHint | null }): Promise<string> {
    const me = this.#requireMe();
    await this.activate();
    const target = this.#target(input.path, input.from, input.to);
    return this.#doc.add({
      kind: 'suggestion',
      anchor: target?.anchor ?? null,
      path: input.path,
      quote: target?.quote ?? '',
      replacement: input.replacement,
      plain: null,
      body: (input.body ?? '').trim(),
      author: me,
      pdf: input.pdf ?? null,
    });
  }

  /** A change of PDF words that could not be turned into a source change; the author makes it by hand. */
  async suggestPlain(input: { path: Path | null; from: number; to: number; before: string; after: string; body?: string; pdf: PdfHint | null }): Promise<string> {
    const me = this.#requireMe();
    await this.activate();
    const target = input.path ? this.#target(input.path, input.from, input.to) : null;
    return this.#doc.add({
      kind: 'suggestion',
      anchor: target?.anchor ?? null,
      path: input.path,
      quote: target?.quote ?? input.before,
      replacement: null,
      plain: { before: input.before, after: input.after },
      body: (input.body ?? '').trim(),
      author: me,
      pdf: input.pdf,
    });
  }

  reply(id: string, text: string): void {
    const trimmed = text.trim();
    if (trimmed) this.#doc.reply(id, this.#requireMe(), trimmed);
  }

  removeReply(id: string, replyId: string): void {
    this.#doc.removeReply(id, replyId);
  }

  edit(id: string, patch: { body?: string; replacement?: string }): void {
    this.#doc.edit(id, patch);
  }

  resolve(id: string): void {
    this.#doc.setStatus(id, 'resolved', this.#requireMe());
  }

  reopen(id: string): void {
    this.#doc.setStatus(id, 'open', this.#requireMe());
  }

  reject(id: string): void {
    this.#doc.setStatus(id, 'rejected', this.#requireMe());
  }

  /** Marks a suggestion the author carried out by hand as done. */
  markDone(id: string): void {
    this.#doc.setStatus(id, 'accepted', this.#requireMe());
  }

  remove(id: string): void {
    if (this.state.get().selected === id) this.state.patch({ selected: null });
    this.#doc.remove(id);
  }

  /**
   * Makes the suggested change in the source and marks the suggestion
   * accepted, together with the same suggestion made by someone else. When
   * the text under it changed or was deleted since, only with `anyway`.
   */
  async accept(id: string, options: { anyway?: boolean } = {}): Promise<void> {
    const me = this.#requireMe();
    this.#resolveNow();
    const before = this.thread(id);
    if (before?.at && !before.at.deleted) await this.#catchUp(before.at.path);
    const thread = this.thread(id);
    if (!thread || thread.kind !== 'suggestion' || thread.replacement === null) throw new Error('This suggestion cannot be applied by itself.');
    if (thread.status !== 'open') return;
    if (!thread.at || thread.at.deleted) throw new Error('The text this suggestion is about is no longer in the project.');
    if ((thread.changed || thread.gone) && !options.anyway) {
      throw new Error('The text under this suggestion changed since it was made. Look at it again, and choose "Accept anyway" if it still fits.');
    }
    const twins = this.#twins(thread);
    await this.#host.applyEdit(thread.at.path, { from: thread.at.from, to: thread.at.to, insert: thread.replacement });
    this.#doc.doc.transact(() => {
      for (const done of [thread, ...twins]) this.#doc.setStatus(done.id, 'accepted', me);
    });
    this.#resolveNow();
  }

  /**
   * Accepts every open suggestion whose text is still as it was. Suggestions
   * on words that an earlier one in the same run changed are left open.
   */
  async acceptAll(): Promise<{ accepted: number; skipped: number }> {
    this.#requireMe();
    this.#resolveNow();
    const open = (): ResolvedThread[] => this.state.get().threads.filter((thread) => thread.kind === 'suggestion' && thread.status === 'open' && thread.replacement !== null && thread.at !== null && !thread.at.deleted);
    for (const path of new Set(open().map((thread) => thread.at!.path))) await this.#catchUp(path);
    const ready = open()
      .filter((thread) => !thread.changed && !thread.gone)
      // From the end of each file backwards, so earlier positions stay right.
      .sort((a, b) => (a.at!.path === b.at!.path ? b.at!.from - a.at!.from : a.at!.path.localeCompare(b.at!.path)));
    for (const candidate of ready) {
      // Positions are worked out again before each one: the ones before may have changed its words.
      this.#resolveNow();
      const thread = this.thread(candidate.id);
      if (!thread || thread.status !== 'open' || !thread.at || thread.at.deleted || thread.changed || thread.gone) continue;
      await this.accept(thread.id);
    }
    const accepted = ready.filter((thread) => this.thread(thread.id)?.status === 'accepted').length;
    return { accepted, skipped: ready.length - accepted };
  }

  /** Other open suggestions that make exactly the same change. */
  #twins(thread: ResolvedThread): ResolvedThread[] {
    const at = thread.at!;
    return this.state
      .get()
      .threads.filter(
        (other) =>
          other.id !== thread.id &&
          other.kind === 'suggestion' &&
          other.status === 'open' &&
          other.replacement === thread.replacement &&
          other.at !== null &&
          other.at.fileId === at.fileId &&
          other.at.from === at.from &&
          other.at.to === at.to &&
          !other.changed &&
          !other.gone,
      );
  }

  /** Makes sure the mirror holds what the editor has for `path`, in case a change reached the file some other way. */
  async #catchUp(path: Path): Promise<void> {
    if (this.#tracking()) {
      const text = await this.#host.readText(path).catch(() => null);
      if (text !== null && this.#mirror.text(path) !== text) this.#mirror.setText(path, text);
    }
    this.#resolveNow();
  }

  // ---- review files ----------------------------------------------------------------

  /** A review copy for someone else to comment on. */
  async reviewCopy(input: {
    projectName: string;
    pdf: Uint8Array | null;
    synctex: string | null;
    mainFile: Path | null;
    knownPaths: Path[];
    workDir: Path;
    siteUrl: string;
  }): Promise<{ name: string; bytes: Uint8Array }> {
    const me = this.#requireMe();
    await this.activate();
    await this.#syncAll();
    const files = this.#mirror.paths().map((path) => ({ path, text: this.#mirror.text(path)! }));
    const reviewId = this.#doc.reviewId();
    await this.#host.vault.setSetting(`review:authored:${reviewId}`, this.#host.projectId);
    const copy: ReviewCopy = {
      manifest: {
        format: 'scribetex-review',
        version: 1,
        kind: 'review-copy',
        reviewId,
        project: input.projectName,
        from: me,
        createdAt: Date.now(),
        mainFile: input.mainFile,
        workDir: input.workDir,
        knownPaths: input.knownPaths,
      },
      files,
      mirror: this.#mirror.encode(),
      review: this.#doc.encode(),
      pdf: input.pdf,
      synctex: input.synctex,
    };
    await this.#flush();
    return { name: `${fileSafe(input.projectName)} - review copy${REVIEW_EXTENSION}`, bytes: writeReviewCopy(copy, input.siteUrl) };
  }

  /** The comments made here, to send back to the author. */
  async commentsFile(projectName: string, siteUrl: string): Promise<{ name: string; bytes: Uint8Array }> {
    const me = this.#requireMe();
    const file: CommentsFile = {
      manifest: {
        format: 'scribetex-review',
        version: 1,
        kind: 'comments',
        reviewId: this.#doc.reviewId(),
        project: projectName,
        from: me,
        createdAt: Date.now(),
        mainFile: null,
        workDir: '',
        knownPaths: [],
      },
      review: this.#doc.encode(),
    };
    await this.#flush();
    return { name: `${fileSafe(projectName)} - comments from ${fileSafe(me.name)}${REVIEW_EXTENSION}`, bytes: writeComments(file, siteUrl) };
  }

  /** Whether a review file belongs to this project. */
  owns(reviewId: string): boolean {
    return this.#doc.hasReviewId() && this.#doc.reviewId() === reviewId;
  }

  /** Merges comments that came back in a file. */
  async mergeComments(review: Uint8Array): Promise<MergeSummary> {
    await this.activate();
    const summary = this.#doc.merge(review);
    this.#resolveNow();
    return summary;
  }

  // ---- keeping the mirror in step -------------------------------------------------------

  /**
   * Switches review on: the mirror starts from the files as they are now.
   * Another tab of the project may have switched it on since this one
   * opened, so what is stored comes first; a tab that cannot change the
   * project builds on it and never replaces it.
   */
  async activate(): Promise<void> {
    if (this.state.get().active) return;
    const stored = await this.#mirrorStore.load();
    const writer = this.state.get().role === 'author' && this.#host.canWrite();
    if (writer || !stored) this.#mirror.reconcile(await this.#textFiles());
    this.state.patch({ active: true });
    if (writer) await this.#mirrorStore.rewrite();
    // Kept even here, so comments made in this tab keep their place; the editing tab builds on it.
    else if (!stored && this.state.get().role === 'author') await this.#mirrorStore.storeAll();
    this.#resolveNow();
  }

  /** The editor's own changes to an open file, exactly as it made them. */
  trackEdit(path: Path, changes: readonly TextChange[], after: string): void {
    if (!this.#tracking()) return;
    this.#mirror.applyChanges(path, changes, after);
    this.#scheduleResolve(250);
  }

  /** After a save: the mirror must hold what was saved. */
  async verify(paths: readonly Path[]): Promise<void> {
    if (!this.#tracking()) return;
    for (const path of paths) {
      const text = await this.#host.readText(path).catch(() => null);
      if (text !== null && this.#mirror.text(path) !== text) this.#mirror.setText(path, text);
    }
  }

  /** Reads everything again from storage, for a tab that just took the project over from another. */
  async restart(): Promise<void> {
    this.#mirrorStore.enabled = false;
    await this.#mirrorStore.dispose();
    await this.#reviewStore.dispose();
    this.#mirror = new SourceMirror();
    this.#doc = new ReviewDoc();
    this.#mirrorStore = new DocPersistence(this.#host.storage, this.#host.projectId, 'mirror', this.#mirror.doc, { delayMs: 800 });
    this.#reviewStore = new DocPersistence(this.#host.storage, this.#host.projectId, 'review', this.#doc.doc);
    this.state.patch({ active: false });
    await this.#load();
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#resolveTimer) clearTimeout(this.#resolveTimer);
    if (this.#reconcileTimer) clearTimeout(this.#reconcileTimer);
    for (const dispose of this.#disposers) dispose();
    await this.#mirrorStore.dispose();
    await this.#reviewStore.dispose();
  }

  // ---- internals ---------------------------------------------------------------------

  async #load(): Promise<void> {
    const role = this.state.get().role;
    this.#mirrorStore.enabled = role === 'author' && this.#host.canWrite();
    const hadReview = await this.#reviewStore.load();
    const hadMirror = await this.#mirrorStore.load();
    this.#wireDocs();
    if (hadReview || hadMirror) {
      this.state.patch({ active: true });
      // Files may have changed while the project was closed, in this browser or in its folder.
      if (this.#tracking()) this.#mirror.reconcile(await this.#textFiles());
    }
    this.#resolveNow();
  }

  #wireDocs(): void {
    const mirror = this.#mirror;
    const doc = this.#doc;
    const onMirror = (): void => this.#scheduleResolve(250);
    mirror.doc.on('update', onMirror);
    const offReview = doc.changed.on(() => this.#scheduleResolve(0));
    this.#disposers.push(() => mirror.doc.off('update', onMirror), offReview);
  }

  #tracking(): boolean {
    const state = this.state.get();
    return state.active && state.role === 'author' && this.#host.canWrite() && !this.#disposed;
  }

  #requireMe(): Person {
    const me = this.state.get().me;
    if (!me) throw new NeedNameError();
    return me;
  }

  #target(path: Path, from: number, to: number): { anchor: NonNullable<ReturnType<SourceMirror['anchor']>>; quote: string } | null {
    const anchor = this.#mirror.anchor(path, from, to);
    const text = this.#mirror.text(path);
    if (!anchor || text === null) return null;
    return { anchor, quote: text.slice(from, to) };
  }

  async #textFiles(): Promise<{ path: Path; text: string }[]> {
    const entries = await this.#host.vault.list(this.#host.projectId);
    const files: { path: Path; text: string }[] = [];
    for (const entry of entries) {
      if (entry.kind !== 'file' || !entry.text || entry.size > MAX_TEXT_BYTES || isBuildArtifact(entry.path)) continue;
      files.push({ path: entry.path, text: await this.#host.readText(entry.path) });
    }
    return files;
  }

  async #syncAll(): Promise<void> {
    if (this.#tracking()) this.#mirror.reconcile(await this.#textFiles());
  }

  async #flush(): Promise<void> {
    await this.#mirrorStore.flush();
    await this.#reviewStore.flush();
  }

  #onVaultChange(change: VaultChange): void {
    if (change.projectId !== this.#host.projectId || !this.#tracking()) return;
    switch (change.type) {
      case 'write':
        // The editor's changes arrive through trackEdit, exactly.
        if (change.origin === 'editor') return;
        if (change.entry.text && !isBuildArtifact(change.path) && change.entry.size <= MAX_TEXT_BYTES) {
          void this.#host.readText(change.path).then(
            (text) => {
              if (this.#tracking()) this.#mirror.setText(change.path, text);
            },
            () => undefined,
          );
        } else if (this.#mirror.fileId(change.path)) {
          this.#mirror.remove([change.path]);
        }
        return;
      case 'remove':
        this.#mirror.remove(change.paths);
        return;
      case 'move':
        this.#mirror.rename(change.from, change.to);
        return;
      case 'bulk':
        if (this.#reconcileTimer) clearTimeout(this.#reconcileTimer);
        this.#reconcileTimer = setTimeout(() => {
          this.#reconcileTimer = null;
          void this.#syncAll();
        }, 100);
        return;
      default:
        return;
    }
  }

  #scheduleResolve(ms: number): void {
    if (this.#disposed) return;
    if (this.#resolveTimer && ms > 0) return;
    if (this.#resolveTimer) clearTimeout(this.#resolveTimer);
    this.#resolveTimer = setTimeout(() => {
      this.#resolveTimer = null;
      this.#resolveNow();
    }, ms);
  }

  #resolveNow(): void {
    if (this.#resolveTimer) {
      clearTimeout(this.#resolveTimer);
      this.#resolveTimer = null;
    }
    const mirror = this.#mirror;
    const threads = this.#doc.threads().map((thread): ResolvedThread => {
      const at = thread.anchor ? mirror.resolve(thread.anchor) : null;
      if (!at) return { ...thread, at: null, changed: false, gone: false };
      const text = mirror.textOf(at.fileId) ?? '';
      const now = text.slice(at.from, at.to);
      const gone = at.from === at.to && thread.quote.length > 0;
      return { ...thread, at, changed: !gone && now !== thread.quote, gone };
    });
    threads.sort(compareThreads);
    const state = this.state.get();
    const selected = state.selected && threads.some((thread) => thread.id === state.selected) ? state.selected : null;
    this.state.patch({ threads, selected, version: state.version + 1 });
  }
}

function compareThreads(a: ResolvedThread, b: ResolvedThread): number {
  if (a.at && b.at) return a.at.path === b.at.path ? a.at.from - b.at.from || a.createdAt - b.createdAt : a.at.path.localeCompare(b.at.path);
  if (a.at) return -1;
  if (b.at) return 1;
  return a.createdAt - b.createdAt;
}

function fileSafe(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().replace(/\s+/g, ' ');
  return cleaned === '' ? 'project' : cleaned;
}
