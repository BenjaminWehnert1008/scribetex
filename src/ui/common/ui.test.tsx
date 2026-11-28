// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dialog, Menu } from './ui';

// The dialog only shares a file with the toasts; the app's services are not needed here.
vi.mock('@/app/services', async () => {
  const { Store } = await import('@/core/store');
  return { toasts: new Store([]), dismissToast: () => undefined };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let opener: HTMLButtonElement;
let root: Root;

const render = (node: ReactNode): void => act(() => root.render(node));
const field = (name: string): HTMLInputElement => host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
const form = (
  <>
    <input name="repository" />
    <input name="token" />
  </>
);

beforeEach(() => {
  opener = document.createElement('button');
  host = document.createElement('div');
  document.body.append(opener, host);
  opener.focus();
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  opener.remove();
});

describe('Dialog', () => {
  it('puts the focus on its first field when it opens', () => {
    render(<Dialog title="Connect">{form}</Dialog>);
    expect(document.activeElement).toBe(field('repository'));
  });

  it('leaves the focus where it is when it is rendered again with another onClose', () => {
    render(<Dialog title="Connect" onClose={() => undefined}>{form}</Dialog>);
    field('token').focus();
    // What a caller does all the time: a new function, or none while it is busy.
    render(<Dialog title="Connect" onClose={() => undefined}>{form}</Dialog>);
    expect(document.activeElement).toBe(field('token'));
    render(<Dialog title="Connect">{form}</Dialog>);
    expect(document.activeElement).toBe(field('token'));
    render(<Dialog title="Connect" onClose={() => undefined}>{form}</Dialog>);
    expect(document.activeElement).toBe(field('token'));
  });

  it('closes on Escape with the onClose of the latest render, and not at all without one', () => {
    const first = vi.fn();
    const second = vi.fn();
    const escape = (): void => act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));

    render(<Dialog title="Connect" onClose={first}>{form}</Dialog>);
    render(<Dialog title="Connect" onClose={second}>{form}</Dialog>);
    escape();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);

    render(<Dialog title="Connect">{form}</Dialog>);
    escape();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('gives the focus back when it closes', () => {
    render(<Dialog title="Connect">{form}</Dialog>);
    render(null);
    expect(document.activeElement).toBe(opener);
  });
});

describe('Menu', () => {
  const items = [
    { label: 'One', run: () => undefined },
    { label: 'Two', run: () => undefined },
  ];
  const menu = (): HTMLElement => host.querySelector<HTMLElement>('.menu')!;

  beforeEach(() => {
    // happy-dom does no layout, so the window and the menu get a size here.
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1000);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 150, width: 200, height: 150, toJSON: () => ({}),
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('opens below its button when it fits', () => {
    render(<Menu x={100} y={300} above={270} items={items} onClose={() => undefined} />);
    expect([menu().style.left, menu().style.top]).toEqual(['100px', '300px']);
  });

  it('opens above its button when it does not fit below, so that a second click cannot choose an item', () => {
    render(<Menu x={100} y={700} above={670} items={items} onClose={() => undefined} />);
    expect(menu().style.top).toBe(`${670 - 4 - 150}px`);
  });

  it('stays inside the window when it fits neither below nor above', () => {
    render(<Menu x={900} y={700} above={100} items={items} onClose={() => undefined} />);
    expect([menu().style.left, menu().style.top]).toEqual([`${1000 - 200 - 4}px`, '4px']);
  });
});
