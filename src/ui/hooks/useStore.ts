import { useSyncExternalStore } from 'react';
import type { ReadonlyStore } from '@/core/store';

/** Subscribes a component to a core store. */
export function useStore<T>(store: ReadonlyStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
