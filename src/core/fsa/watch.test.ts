import { describe, expect, it, vi } from 'vitest';
import type { DirHandle } from './disk';
import { observerSupported, watchFolder } from './watch';

type Callback = (records: { type: string }[]) => void;

function fakeScope(options: { observeFails?: boolean } = {}) {
  const instances: { callback: Callback; observed: unknown[]; options: unknown[]; disconnected: boolean }[] = [];
  class FileSystemObserver {
    readonly state = { callback: null as unknown as Callback, observed: [] as unknown[], options: [] as unknown[], disconnected: false };
    constructor(callback: Callback) {
      this.state.callback = callback;
      instances.push(this.state);
    }
    observe(handle: unknown, opts: unknown): Promise<void> {
      this.state.observed.push(handle);
      this.state.options.push(opts);
      return options.observeFails ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve();
    }
    disconnect(): void {
      this.state.disconnected = true;
    }
  }
  return { scope: { FileSystemObserver }, instances };
}

const root = { kind: 'directory', name: 'Thesis' } as unknown as DirHandle;

describe('watchFolder', () => {
  it('returns null where the browser cannot watch folders', () => {
    expect(observerSupported({})).toBe(false);
    expect(watchFolder(root, () => undefined, () => undefined, {})).toBeNull();
  });

  it('watches the whole folder and reports changes', () => {
    const { scope, instances } = fakeScope();
    const onChange = vi.fn();
    const stop = watchFolder(root, onChange, () => undefined, scope);
    expect(stop).toBeTypeOf('function');
    expect(instances[0]!.observed).toEqual([root]);
    expect(instances[0]!.options).toEqual([{ recursive: true }]);
    instances[0]!.callback([{ type: 'modified' }, { type: 'appeared' }]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('stops reporting once stopped', () => {
    const { scope, instances } = fakeScope();
    const onChange = vi.fn();
    const stop = watchFolder(root, onChange, () => undefined, scope)!;
    stop();
    expect(instances[0]!.disconnected).toBe(true);
    instances[0]!.callback([{ type: 'modified' }]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('says when the browser stopped watching', () => {
    const { scope, instances } = fakeScope();
    const onChange = vi.fn();
    const onLost = vi.fn();
    watchFolder(root, onChange, onLost, scope);
    instances[0]!.callback([{ type: 'errored' }]);
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    expect(instances[0]!.disconnected).toBe(true);
  });

  it('says so when watching could not start', async () => {
    const { scope } = fakeScope({ observeFails: true });
    const onLost = vi.fn();
    watchFolder(root, () => undefined, onLost, scope);
    await vi.waitFor(() => expect(onLost).toHaveBeenCalledTimes(1));
  });
});
