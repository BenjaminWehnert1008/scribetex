/**
 * A minimal observable value. Core modules expose their state through stores so
 * the UI can subscribe with `useSyncExternalStore` and tests can read it directly.
 */
export interface ReadonlyStore<T> {
  get(): T;
  /** Calls `listener` after every change. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

export class Store<T> implements ReadonlyStore<T> {
  #value: T;
  readonly #listeners = new Set<() => void>();

  constructor(initial: T) {
    this.#value = initial;
  }

  get = (): T => this.#value;

  set = (next: T | ((previous: T) => T)): void => {
    const value = typeof next === 'function' ? (next as (previous: T) => T)(this.#value) : next;
    if (Object.is(value, this.#value)) return;
    this.#value = value;
    for (const listener of [...this.#listeners]) listener();
  };

  /** Shallow-merges `patch` into an object-valued store. */
  patch = (patch: Partial<T>): void => {
    const current = this.#value as Record<string, unknown>;
    let changed = false;
    for (const key of Object.keys(patch)) {
      if (!Object.is(current[key], (patch as Record<string, unknown>)[key])) {
        changed = true;
        break;
      }
    }
    if (changed) this.set({ ...this.#value, ...patch });
  };

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
}

/** A typed event emitter for one-off notifications that are not state. */
export class Emitter<E> {
  readonly #listeners = new Set<(event: E) => void>();

  on = (listener: (event: E) => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  emit = (event: E): void => {
    for (const listener of [...this.#listeners]) listener(event);
  };
}
