/**
 * Asking the user for a folder on their disk. Only Chromium browsers on a
 * computer can do this; everywhere else `canPickFolder()` is false and the
 * interface explains the alternatives.
 */
import type { DirHandle } from '@/core/fsa/disk';

type Picker = (options?: { mode?: 'read' | 'readwrite'; id?: string }) => Promise<DirHandle>;

function picker(): Picker | null {
  const candidate = (window as unknown as { showDirectoryPicker?: Picker }).showDirectoryPicker;
  return typeof candidate === 'function' ? candidate.bind(window) : null;
}

export function canPickFolder(): boolean {
  return picker() !== null;
}

/** Opens the browser's folder dialog. Resolves to null when the user closes it without choosing. */
export async function pickFolder(): Promise<DirHandle | null> {
  const pick = picker();
  if (!pick) throw new Error('This browser cannot open folders. Use Chrome or Edge on a computer.');
  try {
    return await pick({ mode: 'readwrite', id: 'latex-project' });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return null;
    throw error;
  }
}
