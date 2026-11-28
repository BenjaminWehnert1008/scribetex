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

  /** Frames are run by hand; each request gets a new id, like in a browser. */
  function stubFrames() {
    const frames: FrameRequestCallback[] = [];
    let id = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => (frames.push(callback), ++id));
    const cancel = vi.fn();
    vi.stubGlobal('cancelAnimationFrame', cancel);
    return { frames, cancel, last: () => id };
  }

  it('animates the typewriter and stops when it goes away', () => {
    const { frames, cancel, last } = stubFrames();
    const { svg, unmount } = mount();
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    const before = colours(svg);
    expect(before).toBeGreaterThan(3);
    // Four seconds of frames: the paper is out, so its white and its lines are drawn too.
    for (let time = 0; time < 4000; time += 16) act(() => frames.shift()!(time));
    expect(colours(svg)).toBeGreaterThan(before);
    unmount();
    // The frame asked for last is the one cancelled, so the loop really ends.
    expect(cancel).toHaveBeenLastCalledWith(last());
  });

  it('pauses while it is out of sight and goes on when it is shown again', () => {
    const { frames, cancel, last } = stubFrames();
    let report: (visible: boolean) => void = () => undefined;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
          report = (visible) => callback([{ isIntersecting: visible }]);
        }
        observe(): void {}
        disconnect(): void {}
      },
    );
    const { svg } = mount();
    for (let time = 0; time < 2000; time += 16) act(() => frames.shift()!(time));
    // Hidden, for example behind the Source tab on a phone: no more frames.
    act(() => report(false));
    expect(cancel).toHaveBeenLastCalledWith(last());
    frames.length = 0;
    const hidden = svg.innerHTML;
    // Shown again: it carries on from where it was.
    act(() => report(true));
    expect(frames).toHaveLength(1);
    for (let time = 9000; time < 9500; time += 16) act(() => frames.shift()!(time));
    expect(svg.innerHTML).not.toBe(hidden);
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
