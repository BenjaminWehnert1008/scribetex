import { useEffect, useRef, useState } from 'react';
import { PixelPaths, pixelPaths, reducedMotion } from '../common/pixel-art';
import { advance, createScene, renderScene, SCENE_HEIGHT, SCENE_WIDTH } from './paper-pile';

const SCALE = 4;
/** Pixel art needs no more than this many pictures a second. */
const FRAME_MS = 33;

/** With reduced motion: one still picture of a pile that has grown for a while. */
function stillPicture(): string[] {
  const scene = createScene(1);
  for (let ms = 0; ms < 14_000; ms += 100) advance(scene, 100);
  scene.key = null;
  scene.spaceUntil = 0;
  return renderScene(scene);
}

/**
 * The typewriter that types on and on while the first PDF of a project is
 * being made (see paper-pile.ts). It is only decoration: the text beside it
 * says what is going on.
 */
export function PaperPile() {
  const [still] = useState(reducedMotion);
  const [rows, setRows] = useState(() => (still ? stillPicture() : renderScene(createScene(0))));
  const svg = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (still) return;
    const scene = createScene(Math.floor(Math.random() * 2 ** 31));
    let frame = 0;
    let last: number | null = null;
    let painted = -Infinity;
    const tick = (now: number): void => {
      // A hidden tab gets no frames; after it, carry on instead of jumping ahead.
      advance(scene, last === null ? 0 : Math.min(100, now - last));
      last = now;
      if (now - painted >= FRAME_MS) {
        painted = now;
        setRows(renderScene(scene));
      }
      frame = requestAnimationFrame(tick);
    };
    const start = (): void => {
      if (frame !== 0) return;
      last = null;
      frame = requestAnimationFrame(tick);
    };
    const stop = (): void => {
      cancelAnimationFrame(frame);
      frame = 0;
    };
    // On a narrow screen the PDF pane is often hidden behind another tab: then
    // the typewriter pauses instead of drawing 30 pictures a second for nobody.
    // The last entry is the newest, when it was hidden and shown in quick succession.
    const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => (entries[entries.length - 1].isIntersecting ? start() : stop())) : null;
    if (svg.current) observer?.observe(svg.current);
    start();
    return () => {
      observer?.disconnect();
      stop();
    };
  }, [still]);

  return (
    <svg
      ref={svg}
      className="paper-pile"
      viewBox={`0 0 ${SCENE_WIDTH} ${SCENE_HEIGHT}`}
      width={SCENE_WIDTH * SCALE}
      height={SCENE_HEIGHT * SCALE}
      shapeRendering="crispEdges"
      aria-hidden
    >
      <PixelPaths parts={pixelPaths(rows)} />
    </svg>
  );
}
