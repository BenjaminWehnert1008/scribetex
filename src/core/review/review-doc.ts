/**
 * All comments and suggestions of a project, as a Yjs document.
 *
 * Being a CRDT, review files from several people merge without conflicts: a
 * reply written by the supervisor and the author's "resolved" both survive,
 * and reading the same file twice changes nothing. A live connection between
 * editors could later carry the same document.
 */
import * as Y from 'yjs';
import { Emitter } from '../store';
import type { Millis } from '../types';
import type { Anchor } from './mirror';
import type { NewThread, PdfHint, PdfRect, Person, Reply, Thread, ThreadKind, ThreadStatus } from './types';

/** Transaction origin of changes made on this computer. */
export const LOCAL = 'local';

export interface MergeSummary {
  threads: number;
  replies: number;
  /** Threads whose status changed, such as accepted suggestions. */
  decided: number;
  people: string[];
}

function newId(prefix: string): string {
  const random = crypto.getRandomValues(new Uint32Array(2));
  return `${prefix}${Date.now().toString(36)}${random[0]!.toString(36)}${random[1]!.toString(36)}`;
}

export class ReviewDoc {
  readonly doc: Y.Doc;
  /** Fires after every change, local or merged in. */
  readonly changed = new Emitter<{ local: boolean }>();
  readonly #threads: Y.Map<Y.Map<unknown>>;
  readonly #meta: Y.Map<unknown>;
  #cache: Thread[] | null = null;
  readonly #now: () => Millis;

  constructor(doc: Y.Doc = new Y.Doc(), options: { now?: () => Millis } = {}) {
    this.doc = doc;
    this.#now = options.now ?? Date.now;
    this.#threads = doc.getMap('threads');
    this.#meta = doc.getMap('meta');
    doc.on('update', (_update: Uint8Array, origin: unknown) => {
      this.#cache = null;
      this.changed.emit({ local: origin === LOCAL });
    });
  }

  /** The id that ties review files to this project. Made on first use. */
  reviewId(): string {
    const existing = this.#meta.get('reviewId');
    if (typeof existing === 'string') return existing;
    const id = newId('r');
    this.doc.transact(() => this.#meta.set('reviewId', id), LOCAL);
    return id;
  }

  hasReviewId(): boolean {
    return typeof this.#meta.get('reviewId') === 'string';
  }

  threads(): Thread[] {
    this.#cache ??= [...this.#threads.entries()].map(([id, map]) => readThread(id, map)).sort((a, b) => a.createdAt - b.createdAt);
    return this.#cache;
  }

  get(id: string): Thread | null {
    return this.threads().find((thread) => thread.id === id) ?? null;
  }

  add(input: NewThread): string {
    const id = newId('t');
    this.doc.transact(() => {
      const map = new Y.Map<unknown>();
      map.set('kind', input.kind);
      if (input.anchor) {
        map.set('fileId', input.anchor.fileId);
        map.set('start', input.anchor.start);
        map.set('end', input.anchor.end);
      }
      map.set('path', input.path);
      map.set('quote', input.quote);
      map.set('replacement', input.replacement);
      map.set('plain', input.plain);
      map.set('body', input.body);
      map.set('author', { ...input.author });
      map.set('createdAt', this.#now());
      map.set('status', 'open');
      map.set('statusBy', null);
      map.set('statusAt', null);
      map.set('pdf', input.pdf);
      map.set('replies', new Y.Array<Reply>());
      this.#threads.set(id, map);
    }, LOCAL);
    return id;
  }

  reply(threadId: string, author: Person, text: string): void {
    const replies = this.#threads.get(threadId)?.get('replies');
    if (!(replies instanceof Y.Array)) return;
    this.doc.transact(() => replies.push([{ id: newId('c'), author: { ...author }, text, at: this.#now() }]), LOCAL);
  }

  removeReply(threadId: string, replyId: string): void {
    const replies = this.#threads.get(threadId)?.get('replies');
    if (!(replies instanceof Y.Array)) return;
    const index = (replies.toArray() as Reply[]).findIndex((reply) => reply.id === replyId);
    if (index >= 0) this.doc.transact(() => replies.delete(index, 1), LOCAL);
  }

  setStatus(threadId: string, status: ThreadStatus, by: Person): void {
    const map = this.#threads.get(threadId);
    if (!map) return;
    this.doc.transact(() => {
      map.set('status', status);
      map.set('statusBy', status === 'open' ? null : { ...by });
      map.set('statusAt', status === 'open' ? null : this.#now());
    }, LOCAL);
  }

  edit(threadId: string, patch: { body?: string; replacement?: string }): void {
    const map = this.#threads.get(threadId);
    if (!map) return;
    this.doc.transact(() => {
      if (patch.body !== undefined) map.set('body', patch.body);
      if (patch.replacement !== undefined) map.set('replacement', patch.replacement);
    }, LOCAL);
  }

  remove(threadId: string): void {
    if (this.#threads.has(threadId)) this.doc.transact(() => this.#threads.delete(threadId), LOCAL);
  }

  encode(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }

  /** Merges a review file's document in and says what it brought. */
  merge(update: Uint8Array): MergeSummary {
    const before = new Map(this.threads().map((thread) => [thread.id, thread]));
    Y.applyUpdate(this.doc, update, 'file');
    const summary: MergeSummary = { threads: 0, replies: 0, decided: 0, people: [] };
    const people = new Set<string>();
    for (const thread of this.threads()) {
      const old = before.get(thread.id);
      if (!old) {
        summary.threads++;
        people.add(thread.author.name);
      } else if (old.status !== thread.status) {
        summary.decided++;
        if (thread.statusBy) people.add(thread.statusBy.name);
      }
      const known = new Set(old?.replies.map((reply) => reply.id) ?? []);
      for (const reply of thread.replies) {
        if (known.has(reply.id)) continue;
        summary.replies++;
        people.add(reply.author.name);
      }
    }
    summary.people = [...people];
    return summary;
  }
}

/*
 * Everything below reads values that may come from someone else's file, so
 * each one is checked: a damaged or odd file shows as an empty comment, never
 * as a broken page.
 */

function readThread(id: string, map: Y.Map<unknown>): Thread {
  const fileId = map.get('fileId');
  const start = map.get('start');
  const end = map.get('end');
  const anchor: Anchor | null =
    typeof fileId === 'string' && start instanceof Uint8Array && end instanceof Uint8Array ? { fileId, start, end } : null;
  const replies = map.get('replies');
  const kind = map.get('kind') === 'suggestion' ? 'suggestion' : 'comment';
  const replacement = map.get('replacement');
  const path = map.get('path');
  return {
    id,
    kind: kind as ThreadKind,
    anchor,
    path: typeof path === 'string' ? path : null,
    quote: text(map.get('quote')),
    replacement: typeof replacement === 'string' ? replacement : null,
    plain: readPlain(map.get('plain')),
    body: text(map.get('body')),
    author: readPerson(map.get('author')) ?? SOMEONE,
    createdAt: time(map.get('createdAt')) ?? 0,
    status: readStatus(map.get('status')),
    statusBy: readPerson(map.get('statusBy')),
    statusAt: time(map.get('statusAt')),
    pdf: readPdfHint(map.get('pdf')),
    replies: replies instanceof Y.Array ? replies.toArray().map(readReply).filter((reply): reply is Reply => reply !== null) : [],
  };
}

const SOMEONE: Person = { id: 'unknown', name: 'Someone', color: 0 };
/** Colours in the review palette (review.css). */
const COLORS = 8;

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function time(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A person as a file names them, or null when the value is not one. */
export function readPerson(value: unknown): Person | null {
  if (!value || typeof value !== 'object') return null;
  const person = value as Record<string, unknown>;
  if (typeof person.id !== 'string' || typeof person.name !== 'string') return null;
  const name = person.name.trim().slice(0, 60);
  const color = person.color;
  return {
    id: person.id.slice(0, 100),
    name: name === '' ? 'Someone' : name,
    color: typeof color === 'number' && Number.isInteger(color) && color >= 0 && color < COLORS ? color : 0,
  };
}

function readPlain(value: unknown): Thread['plain'] {
  if (!value || typeof value !== 'object') return null;
  const plain = value as Record<string, unknown>;
  return typeof plain.before === 'string' && typeof plain.after === 'string' ? { before: plain.before, after: plain.after } : null;
}

function readPdfHint(value: unknown): PdfHint | null {
  if (!value || typeof value !== 'object') return null;
  const hint = value as Record<string, unknown>;
  if (typeof hint.page !== 'number' || !Number.isInteger(hint.page) || hint.page < 1 || !Array.isArray(hint.rects)) return null;
  const rects = hint.rects
    .slice(0, 200)
    .filter((rect): rect is PdfRect => {
      if (!rect || typeof rect !== 'object') return false;
      const box = rect as Record<string, unknown>;
      return ['left', 'top', 'right', 'bottom'].every((side) => typeof box[side] === 'number' && Number.isFinite(box[side]));
    })
    .map((rect) => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }));
  return { page: hint.page, rects, text: text(hint.text) };
}

function readReply(value: unknown): Reply | null {
  if (!value || typeof value !== 'object') return null;
  const reply = value as Record<string, unknown>;
  if (typeof reply.id !== 'string' || typeof reply.text !== 'string') return null;
  return { id: reply.id, author: readPerson(reply.author) ?? SOMEONE, text: reply.text, at: time(reply.at) ?? 0 };
}

function readStatus(value: unknown): ThreadStatus {
  return value === 'resolved' || value === 'accepted' || value === 'rejected' ? value : 'open';
}
