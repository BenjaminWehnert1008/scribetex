/**
 * The scene shown while the first PDF of a project is being made: the logo's
 * typewriter types on and on, its keys going down one after the other, and
 * an endless sheet of paper comes out of the roller, curls over to the side
 * and drops into a growing, untidy pile on the floor.
 *
 * This file only keeps the state and draws it as a pixel grid (one character
 * per pixel, see src/ui/common/pixel-art.tsx); PaperPile.tsx puts it on the
 * page. Everything is driven by `advance(scene, milliseconds)` and a seeded
 * random generator, so the same seed and steps always give the same picture.
 */
import { BODY, PAPER_LEFT, PAPER_RIGHT, ROLLER } from '../common/pixel-art';

export const SCENE_WIDTH = 80;
export const SCENE_HEIGHT = 46;
/** The row of the floor line; the typewriter and the pile stand on it. */
const FLOOR = SCENE_HEIGHT - 1;

/** Where the typewriter's 24 x 24 grid sits: its lowest row stands on the floor. */
const BODY_BOTTOM = BODY.reduce((last, row, y) => (/[^.]/.test(row) ? y : last), 0);
const X0 = 4;
const Y0 = FLOOR - 1 - BODY_BOTTOM;

/** The paper path: up out of the roller, over in a half circle to the right, then straight down. */
const SHEET_WIDTH = PAPER_RIGHT - PAPER_LEFT + 1;
const HALF = SHEET_WIDTH / 2;
const CX = X0 + PAPER_LEFT + HALF;
const ROLLER_Y = Y0 + ROLLER;
const TOP_Y = 15;
const RADIUS = 9;
const RISE = ROLLER_Y - TOP_Y;
const ARC = Math.PI * RADIUS;
/** Centre of the hanging part, and its outline columns. */
const HANG_X = CX + 2 * RADIUS;
const HANG_LEFT = HANG_X - HALF;
const HANG_RIGHT = HANG_X + HALF - 1;

/** The pile lies between the typewriter and the right edge, and grows no higher than this row. */
const PILE_LEFT = X0 + Math.max(...BODY.map(lastPixel)) + 1;
const PILE_TOP = 24;
/** How steep the pile is: a fold goes one pixel further out for every this many pixels it can lie lower. */
const SLOPE = 0.55;

function lastPixel(row: string): number {
  for (let x = row.length - 1; x >= 0; x--) if (row[x] !== '.') return x;
  return -1;
}

/** Pixels of paper fed per key, and per fold that lands on the pile. */
const FEED_PER_KEY = 1.5;
const FOLD_LENGTH = 11;

/** The keys: single "W" pixels on the keyboard rows; the space bar is the long run. */
const KEYS: { row: number; col: number }[] = [];
let SPACE: { row: number; from: number; to: number } = { row: 0, from: 0, to: -1 };
BODY.forEach((row, y) => {
  for (const match of row.matchAll(/W+/g)) {
    const from = match.index;
    const to = from + match[0].length - 1;
    if (from === to) KEYS.push({ row: y, col: from });
    else if (to - from > SPACE.to - SPACE.from) SPACE = { row: y, from, to };
  }
});

export interface PaperPileScene {
  readonly random: () => number;
  /** Milliseconds since the start. */
  time: number;
  /** Pixels of paper out of the roller, easing towards `target` after each key. */
  feed: number;
  target: number;
  nextKeyAt: number;
  key: { row: number; col: number; until: number } | null;
  spaceUntil: number;
  keysToSpace: number;
  keysToReturn: number;
  /** Paper that has gone into the pile. */
  piled: number;
  /** Per column, the highest row the pile covers (FLOOR where it is empty), counting folds still on their way. */
  readonly surface: number[];
  /** Folds sliding from under the hanging paper to their place on the pile. */
  readonly falling: Fold[];
  /** The pile and the floor, drawn once as each fold lands. */
  readonly ground: string[][];
}

interface Fold {
  readonly shape: string[];
  readonly from: { x: number; y: number };
  readonly to: { x: number; y: number };
  readonly start: number;
  readonly duration: number;
}

/** A small, fast generator with a seed, so that tests can repeat a scene exactly. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createScene(seed: number): PaperPileScene {
  const ground = Array.from({ length: SCENE_HEIGHT }, () => Array<string>(SCENE_WIDTH).fill('.'));
  ground[FLOOR].fill('F');
  return {
    random: generator(seed),
    time: 0,
    feed: 0,
    target: 0,
    nextKeyAt: 350,
    key: null,
    spaceUntil: 0,
    keysToSpace: 4,
    keysToReturn: 34,
    piled: 0,
    surface: Array<number>(SCENE_WIDTH).fill(FLOOR),
    falling: [],
    ground,
  };
}

/** Moves the scene on by some milliseconds. */
export function advance(scene: PaperPileScene, ms: number): void {
  const end = scene.time + Math.max(0, ms);
  while (scene.nextKeyAt <= end) {
    scene.time = scene.nextKeyAt;
    strike(scene);
  }
  const step = end - scene.time;
  scene.time = end;
  scene.feed += (scene.target - scene.feed) * (1 - Math.exp(-step / 45));
  // Paper beyond the end of the hanging part has landed: one fold at a time.
  while (scene.feed - pathLength(scene) - scene.piled >= FOLD_LENGTH) {
    land(scene);
    scene.piled += FOLD_LENGTH;
  }
  // Folds join the pile in the order they fell, so that a later one always lies on top;
  // one that has arrived before an earlier one waits at its place, drawn on top meanwhile.
  while (scene.falling.length > 0 && scene.falling[0].start + scene.falling[0].duration <= scene.time) settle(scene, scene.falling.shift()!);
}

/** One key (or the space bar) goes down, and the paper moves on a little. */
function strike(scene: PaperPileScene): void {
  const { random } = scene;
  // Ease the feed of the time since the last key before adding the next step.
  scene.feed += (scene.target - scene.feed) * 0.9;
  scene.target += FEED_PER_KEY;
  let pause = 55 + random() * 75;
  if (scene.keysToSpace <= 0) {
    scene.spaceUntil = scene.time + 95;
    scene.keysToSpace = 2 + Math.floor(random() * 6);
  } else {
    const key = KEYS[Math.floor(random() * KEYS.length)];
    scene.key = { ...key, until: scene.time + 70 };
    scene.keysToSpace -= 1;
  }
  scene.keysToReturn -= 1;
  if (scene.keysToReturn <= 0) {
    // The end of a line: a short rest, as when the carriage goes back.
    pause += 260 + random() * 200;
    scene.keysToReturn = 26 + Math.floor(random() * 16);
  }
  scene.nextKeyAt = scene.time + pause;
}

/** The highest point of the pile under the hanging paper. */
function landing(scene: PaperPileScene): number {
  let top = FLOOR;
  for (let x = HANG_LEFT; x <= HANG_RIGHT; x++) top = Math.min(top, scene.surface[x]);
  return top;
}

/** How long the paper path is from the roller to the top of the pile. */
function pathLength(scene: PaperPileScene): number {
  return RISE + ARC + (landing(scene) - TOP_Y);
}

/** A point on the path, and the direction across the sheet there (towards the inside of the curl). */
function along(s: number): { x: number; y: number; nx: number; ny: number } {
  if (s <= RISE) return { x: CX, y: ROLLER_Y - s, nx: 1, ny: 0 };
  if (s <= RISE + ARC) {
    const angle = Math.PI - (s - RISE) / RADIUS;
    return { x: CX + RADIUS + RADIUS * Math.cos(angle), y: TOP_Y - RADIUS * Math.sin(angle), nx: -Math.cos(angle), ny: Math.sin(angle) };
  }
  return { x: HANG_X, y: TOP_Y + s - RISE - ARC, nx: -1, ny: 0 };
}

/** How many columns of typing a row of the paper has: every other row is a line, with a blank line now and then. */
function lineLength(row: number): number {
  if (row % 2 !== 0) return 0;
  const hash = Math.imul(row ^ 0x5bd1e995, 0x27d4eb2d) >>> 0;
  if (hash % 7 === 0) return 0;
  return 2 + ((hash >>> 8) % 6);
}

/** A piece of the pile: a flat fold, a tilted one, a roll, a roll with its tail, or a fold with a loop on top. */
function foldShape(random: () => number): string[] {
  const roll = random();
  if (roll < 0.1) return ['.KKKK.', 'KPPPPK', 'KP..PK', 'KPPPPK', '.KKKK.'];
  if (roll < 0.2) {
    const tail = 4 + Math.floor(random() * 4);
    const shape = ['.KKKK.', 'KPPPPK', 'KP..PK', `KPPPPK${'K'.repeat(tail)}`, `.KKKKP${'P'.repeat(tail - 1)}K`, `.....${'K'.repeat(tail + 1)}`];
    const width = 6 + tail;
    return mirror(shape.map((row) => row.padEnd(width, '.')), random);
  }
  if (roll < 0.3) {
    const width = 9 + Math.floor(random() * 4);
    const at = 1 + Math.floor(random() * (width - 6));
    const loop = `${'.'.repeat(at)}KKKK${'.'.repeat(width - at - 4)}`;
    const side = `${'.'.repeat(at - 1)}KP..PK${'.'.repeat(width - at - 5)}`;
    return [loop, side, 'K'.repeat(width), `K${'P'.repeat(width - 2)}K`, 'K'.repeat(width)];
  }
  if (roll < 0.5) {
    // Tilted: two or three steps, each a pixel lower than the one before.
    const steps = 2 + Math.floor(random() * 2);
    const step = 4 + Math.floor(random() * 2);
    const width = steps * step + 1;
    const grid = Array.from({ length: steps + 2 }, () => Array<string>(width).fill('.'));
    for (let i = 0; i < steps; i++) {
      for (let x = i * step; x <= Math.min(width - 1, (i + 1) * step); x++) {
        grid[i][x] = 'K';
        grid[i + 1][x] = grid[i + 1][x] === 'K' ? 'K' : x === i * step || x === (i + 1) * step ? 'K' : 'P';
        grid[i + 2][x] = 'K';
      }
    }
    return mirror(
      grid.map((row) => row.join('')),
      random,
    );
  }
  const width = 8 + Math.floor(random() * 7);
  const text = random() < 0.4 ? 2 + Math.floor(random() * (width - 5)) : 0;
  const from = 1 + Math.floor(random() * 2);
  const middle = [...'P'.repeat(width - 2)].map((pixel, x) => (x >= from && x < from + text ? 'L' : pixel)).join('');
  return ['K'.repeat(width), `K${middle}K`, 'K'.repeat(width)];
}

/** Half of the time, the same shape facing the other way. */
function mirror(shape: string[], random: () => number): string[] {
  return random() < 0.5 ? shape : shape.map((row) => [...row].reverse().join(''));
}

/**
 * A fold drops from the end of the hanging paper and settles where it lies
 * lowest, but not too far from where it fell: so the pile grows as a heap that
 * is highest under the paper and slopes away from it, and leans against the
 * typewriter on the left. Folds squash into the ones below them a little.
 */
function land(scene: PaperPileScene): void {
  const { random, surface } = scene;
  const shape = foldShape(random);
  const width = shape[0].length;
  const height = shape.length;
  // Per column of the fold, its first and last row with paper in it.
  const tops = Array.from({ length: width }, (_, x) => shape.findIndex((row) => row[x] !== '.'));
  const bottoms = Array.from({ length: width }, (_, x) => shape.findLastIndex((row) => row[x] !== '.'));
  /** The row of the fold's top when it lies at `left`: as low as it goes until a column touches the pile. */
  const restAt = (left: number): number => {
    let rest = Infinity;
    for (let x = 0; x < width; x++) if (bottoms[x] >= 0) rest = Math.min(rest, surface[left + x] - 1 - bottoms[x]);
    return rest;
  };
  const highest = PILE_TOP - height + 1;
  let best = PILE_LEFT;
  let bestScore = -Infinity;
  for (let left = PILE_LEFT; left <= SCENE_WIDTH - width; left++) {
    // Where the pile is already as high as it may get, the fold just lies on top.
    const rest = Math.max(highest, restAt(left));
    const distance = Math.abs(left + width / 2 - HANG_X);
    const score = rest - SLOPE * distance + random() * 2.5;
    if (score > bestScore) {
      best = left;
      bestScore = score;
    }
  }
  const rest = restAt(best);
  const onFloor = rest + height >= FLOOR;
  const sink = onFloor ? 0 : 1 + (random() < 0.35 ? 1 : 0);
  const y = Math.max(highest, rest + sink);
  // It starts under the end of the hanging paper and slides down the pile to its place.
  const from = { x: Math.round(HANG_X - width / 2), y: Math.min(y, landing(scene) - height) };
  const distance = Math.abs(best - from.x) + Math.abs(y - from.y);
  scene.falling.push({ shape, from, to: { x: best, y }, start: scene.time, duration: Math.min(700, 110 + 24 * distance) });
  for (let dx = 0; dx < width; dx++) {
    if (tops[dx] >= 0) surface[best + dx] = Math.min(surface[best + dx], Math.max(PILE_TOP, y + tops[dx]));
  }
}

/** A fold has arrived: it becomes part of the pile. */
function settle(scene: PaperPileScene, fold: Fold): void {
  const { ground } = scene;
  const { shape, to } = fold;
  const width = shape[0].length;
  const height = shape.length;
  shape.forEach((row, dy) => {
    for (let dx = 0; dx < width; dx++) {
      const pixel = row[dx];
      if (pixel !== '.' && to.y + dy < FLOOR) ground[to.y + dy][to.x + dx] = pixel;
    }
  });
  // Outlines that are now inside the pile turn light grey, so that only the
  // outside of the pile is drawn in black and the layers stay visible.
  for (let y = Math.max(1, to.y - 1); y <= Math.min(FLOOR - 1, to.y + height); y++) {
    for (let x = Math.max(1, to.x - 1); x <= Math.min(SCENE_WIDTH - 2, to.x + width); x++) {
      if (ground[y][x] !== 'K') continue;
      const solid = (cx: number, cy: number): boolean => ground[cy][cx] !== '.';
      if (solid(x - 1, y) && solid(x + 1, y) && solid(x, y - 1) && solid(x, y + 1)) ground[y][x] = 'E';
    }
  }
}

/** The scene as rows of pixel characters. */
export function renderScene(scene: PaperPileScene): string[] {
  const grid = scene.ground.map((row) => row.slice());
  for (const fold of scene.falling) drawFalling(grid, scene, fold);
  drawPaper(grid, scene);
  drawTypewriter(grid, scene);
  return grid.map((row) => row.join(''));
}

function drawFalling(grid: string[][], scene: PaperPileScene, fold: Fold): void {
  // Speeding up as it goes, like something sliding down a slope.
  const t = Math.min(1, Math.max(0, (scene.time - fold.start) / fold.duration));
  const x = Math.round(fold.from.x + (fold.to.x - fold.from.x) * t * t);
  const y = Math.round(fold.from.y + (fold.to.y - fold.from.y) * t * t);
  fold.shape.forEach((row, dy) => {
    for (let dx = 0; dx < row.length; dx++) {
      if (row[dx] !== '.' && y + dy >= 0 && y + dy < FLOOR && x + dx >= 0 && x + dx < SCENE_WIDTH) grid[y + dy][x + dx] = row[dx];
    }
  });
}

function drawPaper(grid: string[][], scene: PaperPileScene): void {
  const bottom = landing(scene);
  const end = RISE + ARC + (bottom - TOP_Y);
  const tip = Math.min(scene.feed, end);
  const leading = scene.feed < end;
  // Start behind the roller so that the paper comes out of it.
  for (let s = -3; s <= tip; s += 0.25) {
    const point = along(s);
    const row = Math.floor(scene.feed - s);
    // The lines of typing show on the straight parts; on the curl the sheet is plain.
    const typed = s > RISE && s <= RISE + ARC ? 0 : lineLength(row);
    const edge = leading && s > tip - 1;
    for (let column = 0; column < SHEET_WIDTH; column++) {
      const pixel = column === 0 || column === SHEET_WIDTH - 1 || edge ? 'K' : column >= 2 && column < 2 + typed ? 'L' : 'P';
      for (const part of [0.25, 0.75]) {
        const across = column - HALF + part;
        const x = Math.floor(point.x + point.nx * across);
        const y = Math.floor(point.y + point.ny * across);
        if (y < 0 || (s > RISE + ARC && y >= bottom) || x < 0 || x >= SCENE_WIDTH) continue;
        grid[y][x] = pixel;
      }
    }
  }
}

function drawTypewriter(grid: string[][], scene: PaperPileScene): void {
  BODY.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] !== '.') grid[Y0 + y][X0 + x] = row[x];
  });
  // A key that is down shows one pixel lower, with a dark gap where it was.
  const press = (row: number, col: number): void => {
    grid[Y0 + row][X0 + col] = 'D';
    grid[Y0 + row + 1][X0 + col] = 'W';
  };
  if (scene.key && scene.time < scene.key.until) press(scene.key.row, scene.key.col);
  if (scene.time < scene.spaceUntil) for (let col = SPACE.from; col <= SPACE.to; col++) press(SPACE.row, col);
}

/** For tests: where things are. */
export const LAYOUT = { FLOOR, X0, Y0, PILE_LEFT, PILE_TOP, HANG_LEFT, HANG_RIGHT, ROLLER_Y, KEYS, SPACE } as const;
