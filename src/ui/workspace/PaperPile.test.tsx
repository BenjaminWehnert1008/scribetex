// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PaperPile } from './PaperPile';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<PaperPile />));
  return { svg: host.querySelector('svg.paper-pile')!, unmount: () => act(() => root.unmount()) };
}

/** The colours in use: one path each. */
const colours = (svg: Element): number => svg.querySelectorAll('path').length;

describe('PaperPile', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('animates the typewriter and stops when it goes away', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
    const cancel = vi.fn();
    vi.stubGlobal('cancelAnimationFrame', cancel);
    const { svg, unmount } = mount();
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    const before = colours(svg);
    expect(before).toBeGreaterThan(3);
    // Four seconds of frames: the paper is out, so its white and its lines are drawn too.
    for (let time = 0; time < 4000; time += 16) act(() => frames.shift()!(time));
    expect(colours(svg)).toBeGreaterThan(before);
    unmount();
    expect(cancel).toHaveBeenCalled();
  });

  it('shows a still picture of a pile with reduced motion', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') }));
    const frame = vi.fn();
    vi.stubGlobal('requestAnimationFrame', frame);
    const { svg } = mount();
    expect(frame).not.toHaveBeenCalled();
    // Typewriter, floor, paper, its lines and the folds of the pile.
    expect(colours(svg)).toBeGreaterThanOrEqual(9);
  });
});
