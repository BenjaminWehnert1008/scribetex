import { useEffect, useState } from 'react';
import { ThemedImage } from '../common/ThemeSwitch';

/**
 * The home page logo, typed in letter by letter like on a typewriter, with a
 * blinking cursor that disappears afterwards. It plays once per page load,
 * waits while `paused` (the first-visit notice covers the page), and does not
 * play at all when the system asks for reduced motion.
 *
 * Positions are in logo pixels (logo.svg is 85 x 24, drawn by
 * scripts/make-logo.mjs): the typewriter ends at 24, and each letter of
 * "scribeTex" starts one pixel after the one before.
 */
const SCALE = 3;
const WIDTHS = [6, 6, 6, 2, 6, 6, 6, 6, 6];
const MARK_END = 24;
const FIRST_LETTER = 27;
const LETTER_ENDS = WIDTHS.reduce<number[]>((ends, width) => {
  const start = ends.length ? ends[ends.length - 1] + 1 : FIRST_LETTER;
  return [...ends, start + width];
}, []);
const TOTAL = LETTER_ENDS.length;

let playedThisLoad = false;

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function TypingLogo(props: { alt: string; paused?: boolean }) {
  const [typed, setTyped] = useState(() => (playedThisLoad || reducedMotion() ? TOTAL : 0));
  const [cursor, setCursor] = useState(typed < TOTAL);

  const waiting = typed < TOTAL && !playedThisLoad;
  useEffect(() => {
    if (!waiting || props.paused) return;
    playedThisLoad = true;
    let count = 0;
    let timer = 0;
    const step = () => {
      count += 1;
      setTyped(count);
      if (count < TOTAL) timer = window.setTimeout(step, 90 + Math.random() * 90);
      else timer = window.setTimeout(() => setCursor(false), 1800);
    };
    timer = window.setTimeout(step, 450);
    return () => window.clearTimeout(timer);
    // Starts once, when not paused; later renders must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.paused]);

  const shown = typed === 0 ? MARK_END : LETTER_ENDS[typed - 1];
  const done = typed >= TOTAL;
  return (
    <span className="typing-logo" style={{ ['--shown' as string]: done ? '100%' : `${shown * SCALE}px` }}>
      <ThemedImage name="logo" alt={props.alt} width={85 * SCALE} height={24 * SCALE} />
      {cursor && <span className="type-cursor" aria-hidden="true" style={{ left: (done ? LETTER_ENDS[TOTAL - 1] + 1 : shown + 1) * SCALE + (typed === 0 ? 2 * SCALE : 0) }} />}
    </span>
  );
}
