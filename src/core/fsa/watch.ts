/**
 * Tells when something changes inside a linked folder, so that edits made by
 * another program (an editor, or Claude working on the folder) reach the
 * project within a second instead of at the next timed pass.
 *
 * Uses the browser's FileSystemObserver (Chrome and Edge). Where it is
 * missing, `watchFolder` returns null and the timer and window focus are what
 * start a pass, as before.
 */
import type { DirHandle } from './disk';

interface ObserverRecord {
  type: 'appeared' | 'disappeared' | 'modified' | 'moved' | 'unknown' | 'errored';
}

interface Observer {
  observe(handle: unknown, options?: { recursive?: boolean }): Promise<void>;
  disconnect(): void;
}

type ObserverConstructor = new (callback: (records: ObserverRecord[], observer: Observer) => void) => Observer;

export function observerSupported(scope: object = globalThis): boolean {
  return typeof (scope as { FileSystemObserver?: unknown }).FileSystemObserver === 'function';
}

/**
 * Calls `onChange` after changes in `root` or below. `onLost` is called when
 * the browser stops watching (the folder was removed, or access was taken
 * back); watching again is then up to the caller. Returns a function that
 * stops watching, or null when the browser cannot watch folders.
 */
export function watchFolder(root: DirHandle, onChange: () => void, onLost: () => void, scope: object = globalThis): (() => void) | null {
  if (!observerSupported(scope)) return null;
  const Constructor = (scope as { FileSystemObserver: ObserverConstructor }).FileSystemObserver;
  let stopped = false;
  let observer: Observer;
  try {
    observer = new Constructor((records) => {
      if (stopped) return;
      if (records.some((record) => record.type === 'errored')) {
        stop();
        onLost();
        return;
      }
      if (records.length > 0) onChange();
    });
  } catch {
    return null;
  }
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    observer.disconnect();
  };
  observer.observe(root, { recursive: true }).catch(() => {
    if (stopped) return;
    stop();
    onLost();
  });
  return stop;
}
