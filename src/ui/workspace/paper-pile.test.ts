import { describe, expect, it } from 'vitest';
import { BODY } from '../common/pixel-art';
import { advance, createScene, LAYOUT, renderScene, SCENE_HEIGHT, SCENE_WIDTH, type PaperPileScene } from './paper-pile';

const { FLOOR, X0, Y0, PILE_LEFT, PILE_TOP, ROLLER_Y, KEYS, SPACE } = LAYOUT;

/** Runs the scene the way the page does: in small steps, about 30 a second. */
function run(scene: PaperPileScene, ms: number, each?: (rows: string[]) => void): void {
  const end = scene.time + ms;
  while (scene.time < end) {
    advance(scene, Math.min(33, end - scene.time));
    each?.(renderScene(scene));
  }
}

const pressedCells = new Set([...KEYS.flatMap((key) => [`${key.row},${key.col}`, `${key.row + 1},${key.col}`])]);
for (let col = SPACE.from; col <= SPACE.to; col++) pressedCells.add(`${SPACE.row},${col}`).add(`${SPACE.row + 1},${col}`);

/** Every pixel of the typewriter is in place, apart from keys that may be down. */
function typewriterIntact(rows: string[]): boolean {
  return BODY.every((row, y) => [...row].every((pixel, x) => pixel === '.' || pressedCells.has(`${y},${x}`) || rows[Y0 + y][X0 + x] === pixel));
}

describe('the paper pile scene', () => {
  it('starts with the typewriter alone on the floor', () => {
    const rows = renderScene(createScene(1));
    expect(rows).toHaveLength(SCENE_HEIGHT);
    expect(rows.every((row) => row.length === SCENE_WIDTH)).toBe(true);
    expect(rows[FLOOR]).toBe('F'.repeat(SCENE_WIDTH));
    expect(typewriterIntact(rows)).toBe(true);
    // No paper anywhere yet: the sheet is still inside the typewriter.
    expect(rows.join('')).not.toMatch(/[PE]/);
  });

  it('feeds the paper out of the roller as the keys go down', () => {
    const scene = createScene(2);
    let keyFrames = 0;
    run(scene, 2000, (rows) => {
      // A key that is down leaves a dark gap where it was.
      const down = KEYS.some((key) => rows[Y0 + key.row][X0 + key.col] === 'D') || rows[Y0 + SPACE.row][X0 + SPACE.from] === 'D';
      if (down) keyFrames++;
    });
    expect(keyFrames).toBeGreaterThan(5);
    const rows = renderScene(scene);
    // Paper stands above the roller, in the sheet's columns.
    expect(rows[ROLLER_Y - 6].slice(X0, X0 + 24)).toContain('P');
    expect(scene.feed).toBeGreaterThan(15);
  });

  it('drops the paper into a pile beside the typewriter that stays inside the picture', () => {
    const scene = createScene(3);
    run(scene, 60_000);
    const rows = renderScene(scene);
    expect(typewriterIntact(rows)).toBe(true);
    expect(scene.piled).toBeGreaterThan(200);
    for (let y = 0; y < FLOOR; y++) {
      for (let x = 0; x < PILE_LEFT; x++) {
        // Left of the pile there is only the typewriter and the rising paper.
        if (rows[y][x] === 'E') throw new Error(`pile pixel at ${x},${y}`);
      }
    }
    expect(Math.min(...scene.surface)).toBeGreaterThanOrEqual(PILE_TOP);
    expect(rows.slice(PILE_TOP, FLOOR).join('')).toMatch(/E/);
  });

  it('keeps going for a long wait without growing out of the picture', () => {
    const scene = createScene(4);
    run(scene, 240_000);
    // In the fifth minute it still types and the pile still grows (about 850 pixels of paper a minute).
    const [fed, piled] = [scene.target, scene.piled];
    run(scene, 60_000);
    expect(scene.target - fed).toBeGreaterThan(500);
    expect(scene.piled).toBeGreaterThan(piled);
    expect(scene.falling.length).toBeLessThan(5);
    expect(Math.min(...scene.surface)).toBeGreaterThanOrEqual(PILE_TOP);
    expect(typewriterIntact(renderScene(scene))).toBe(true);
  });

  it('plays the same way for the same seed', () => {
    const a = createScene(9);
    const b = createScene(9);
    run(a, 15_000);
    run(b, 15_000);
    expect(renderScene(a)).toEqual(renderScene(b));
  });
});
