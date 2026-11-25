import { describe, expect, it, vi } from 'vitest';
import { Emitter, Store } from './store';
import { sha256Hex, encodeText, decodeText } from './hash';
import { newId } from './ids';

describe('Store', () => {
  it('notifies on change and skips identical values', () => {
    const store = new Store({ a: 1, b: 'x' });
    const listener = vi.fn();
    const off = store.subscribe(listener);
    store.patch({ a: 1 });
    expect(listener).not.toHaveBeenCalled();
    store.patch({ a: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get()).toEqual({ a: 2, b: 'x' });
    store.set((s) => ({ ...s, b: 'y' }));
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    store.patch({ a: 3 });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('Emitter', () => {
  it('delivers events until unsubscribed', () => {
    const emitter = new Emitter<number>();
    const seen: number[] = [];
    const off = emitter.on((n) => seen.push(n));
    emitter.emit(1);
    off();
    emitter.emit(2);
    expect(seen).toEqual([1]);
  });
});

describe('hash and ids', () => {
  it('hashes bytes with SHA-256', async () => {
    expect(await sha256Hex(encodeText('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await sha256Hex(new Uint8Array())).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('round-trips text', () => {
    expect(decodeText(encodeText('Größe ∑'))).toBe('Größe ∑');
  });

  it('creates unique, sortable ids', () => {
    const a = newId(1000);
    const b = newId(2000);
    expect(a).toMatch(/^[0-9a-z]{19}$/);
    expect(a < b).toBe(true);
    expect(new Set(Array.from({ length: 500 }, () => newId())).size).toBe(500);
  });
});
