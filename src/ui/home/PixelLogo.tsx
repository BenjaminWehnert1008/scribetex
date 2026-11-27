import { useEffect, useId, useRef, useState } from 'react';
import PIXELS from '@/app/logo-pixels.json';
import {
  BODY,
  MARK,
  PAPER_LEFT,
  PAPER_RIGHT,
  PAPER_TOP,
  paintPixels,
  pixelPaths,
  PixelPaths,
  reducedMotion,
  ROLLER,
  toParts,
  type PixelParts,
} from '../common/pixel-art';

/**
 * The home page logo, drawn from the same pixel data as public/logo.svg, with
 * a typing animation: "scribeTeX" is typed, then the second word is erased and
 * retyped as Thesis, Proposal and CV, and it ends back on "TeX" without the
 * cursor. Like on a real typewriter, the sheet of paper feeds out of the
 * roller a little with every letter typed (erasing does not pull it back): it
 * starts hidden behind the roller and reaches its place in the logo with the
 * last letter. It plays once per page load, waits while `paused` (the
 * first-visit notice) or while the tab is hidden, and does not play with
 * reduced motion.
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

/** The sheet, made long enough that it still reaches the roller when fed all the way back in. */
const SHEET = [
  ...MARK.slice(PAPER_TOP, ROLLER).map((row) => row.slice(PAPER_LEFT, PAPER_RIGHT + 1)),
  ...Array.from({ length: ROLLER - PAPER_TOP }, () => `K${'P'.repeat(PAPER_RIGHT - PAPER_LEFT - 1)}K`),
];
/** Every letter the animation types, erased ones included. */
const KEYSTROKES = FIRST.length + FINAL.length + WORDS.reduce((sum, word) => sum + word.length, 0);
/** How far the sheet feeds out per letter, in pixels: from behind the roller to its place in the logo. */
const FEED = (ROLLER - PAPER_TOP) / KEYSTROKES;

function textEnd(text: string): number {
  let x = LEFT;
  for (const letter of text) x += GLYPHS[letter][0].length + GAP;
  return text ? x - GAP : LEFT - GAP - 2;
}

function drawText(text: string): PixelParts {
  const paths = new Map<string, string[]>();
  paintPixels(BODY, 0, 0, paths);
  let x = LEFT;
  [...text].forEach((letter, index) => {
    const ink = index < FIRST.length ? 'I' : 'A';
    const glyph = GLYPHS[letter].map((row) => row.replaceAll('#', ink));
    paintPixels(glyph, x, TOP, paths);
    x += glyph[0].length + GAP;
  });
  return toParts(paths);
}

let playedThisLoad = false;

/** The typewriter alone, for the top bar; it follows the mode and the colour scheme. */
export function PixelMark(props: { size: number; className?: string }) {
  return (
    <svg className={props.className} viewBox="0 0 24 24" width={props.size} height={props.size} shapeRendering="crispEdges" aria-hidden>
      <PixelPaths parts={pixelPaths(MARK)} />
    </svg>
  );
}

export function PixelLogo(props: { label: string; paused?: boolean }) {
  const [start] = useState(() => !playedThisLoad && !reducedMotion());
  const [text, setText] = useState(start ? '' : FIRST + FINAL);
  const [cursor, setCursor] = useState(start);
  /** Letters typed so far, erased ones included; this drives the paper feed. */
  const [typed, setTyped] = useState(start ? 0 : KEYSTROKES);
  const clip = useId();
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
        setTyped((count) => count + 1);
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
      if (playedThisLoad) {
        setText(FIRST + FINAL);
        setTyped(KEYSTROKES);
      }
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
      {/*
       * The sheet is hidden below the top row of the roller. The clip's edge is
       * smoothed at zoom levels between whole pixels, so it lies one row lower,
       * inside the roller's outline, which is drawn over the sheet.
       */}
      <clipPath id={clip}>
        <rect x={0} y={0} width={WIDTH} height={ROLLER + 1} />
      </clipPath>
      <g clipPath={`url(#${clip})`}>
        <g style={{ transform: `translateY(${(KEYSTROKES - Math.min(typed, KEYSTROKES)) * FEED}px)` }}>
          <PixelPaths parts={pixelPaths(SHEET, PAPER_LEFT, PAPER_TOP)} />
        </g>
      </g>
      <PixelPaths parts={drawText(text)} />
      {cursor && <rect className="pixel-cursor" x={end + 2} y={TOP} width={4} height={TEXT_HEIGHT - 2} />}
    </svg>
  );
}
