import { useEffect, useRef, useState } from 'react';
import PIXELS from '@/app/logo-pixels.json';

/**
 * The home page logo, drawn from the same pixel data as public/logo.svg, with
 * a typing animation: "scribeTeX" is typed, then the second word is erased and
 * retyped as Thesis, Proposal and CV, and it ends back on "TeX" without the
 * cursor. It plays once per page load, waits while `paused` (the first-visit
 * notice) or while the tab is hidden, and does not play with reduced motion.
 */
const FIRST = 'scribe';
const FINAL = 'TeX';
const WORDS = ['Thesis', 'Proposal', 'CV', FINAL];
const { left: LEFT, top: TOP, gap: GAP, height: TEXT_HEIGHT } = PIXELS.text;
const GLYPHS: Record<string, string[]> = PIXELS.glyphs;
const SCALE = 3;
const HEIGHT = 24;
/** Wide enough for the longest word, so the page does not move while typing. */
const WIDTH = Math.max(...WORDS.map((word) => textEnd(FIRST + word)));

/** Colours that change with light and dark mode come from CSS (see tokens.css). */
const THEMED = new Set(Object.keys(PIXELS.dark));

function textEnd(text: string): number {
  let x = LEFT;
  for (const letter of text) x += GLYPHS[letter][0].length + GAP;
  return text ? x - GAP : LEFT - GAP - 2;
}

function paint(grid: string[], left: number, top: number, paths: Map<string, string[]>): void {
  grid.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      const key = row[x];
      let end = x;
      while (end < row.length && row[end] === key) end++;
      if (key !== '.') {
        if (!paths.has(key)) paths.set(key, []);
        paths.get(key)!.push(`M${left + x} ${top + y}h${end - x}v1h-${end - x}z`);
      }
      x = end;
    }
  });
}

function draw(text: string): [string, string][] {
  const paths = new Map<string, string[]>();
  paint(PIXELS.mark, 0, 0, paths);
  let x = LEFT;
  [...text].forEach((letter, index) => {
    const ink = index < FIRST.length ? 'I' : 'A';
    const glyph = GLYPHS[letter].map((row) => row.replaceAll('#', ink));
    paint(glyph, x, TOP, paths);
    x += glyph[0].length + GAP;
  });
  return [...paths].map(([key, parts]) => [key, parts.join('')]);
}

let playedThisLoad = false;

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function PixelLogo(props: { label: string; paused?: boolean }) {
  const [start] = useState(() => !playedThisLoad && !reducedMotion());
  const [text, setText] = useState(start ? '' : FIRST + FINAL);
  const [cursor, setCursor] = useState(start);
  const paused = useRef(props.paused ?? false);
  useEffect(() => {
    paused.current = props.paused ?? false;
  }, [props.paused]);

  useEffect(() => {
    if (!start) return;
    let cancelled = false;
    const sleep = (ms: number) => new Promise((done) => window.setTimeout(done, ms));
    const ready = async () => {
      while (!cancelled && (paused.current || document.hidden)) await sleep(250);
    };
    let shown = '';
    const show = (value: string) => {
      shown = value;
      if (!cancelled) setText(value);
    };
    const type = async (word: string) => {
      for (const letter of word) {
        if (cancelled) return;
        show(shown + letter);
        await sleep(90 + Math.random() * 70);
      }
    };
    const erase = async (count: number) => {
      for (let i = 0; i < count && !cancelled; i++) {
        show(shown.slice(0, -1));
        await sleep(55);
      }
    };
    void (async () => {
      await ready();
      if (cancelled) return;
      playedThisLoad = true;
      await sleep(400);
      await type(FIRST + FINAL);
      let current = FINAL;
      for (const word of WORDS) {
        await sleep(1100);
        await ready();
        await erase(current.length);
        await sleep(200);
        await type(word);
        current = word;
      }
      await sleep(1200);
      if (!cancelled) setCursor(false);
    })();
    return () => {
      cancelled = true;
      // If the page goes away mid-animation, show the full name next time.
      if (playedThisLoad) setText(FIRST + FINAL);
    };
  }, [start]);

  const end = textEnd(text);
  return (
    <svg
      className="pixel-logo"
      role="img"
      aria-label={props.label}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      width={WIDTH * SCALE}
      height={HEIGHT * SCALE}
      shapeRendering="crispEdges"
    >
      {draw(text).map(([key, d]) => (
        <path key={key} d={d} style={{ fill: THEMED.has(key) ? `var(--logo-${key})` : PIXELS.colours[key as keyof typeof PIXELS.colours] }} />
      ))}
      {cursor && <rect className="pixel-cursor" x={end + 2} y={TOP} width={4} height={TEXT_HEIGHT - 2} />}
    </svg>
  );
}
