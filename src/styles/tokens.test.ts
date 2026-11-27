import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import PIXELS from '@/app/logo-pixels.json';
import { ACCENTS } from '@/app/theme';

/** The custom properties of every rule in tokens.css, by selector (nested in @media: both, joined by a space). */
function rules(): Map<string, Map<string, string>> {
  const css = fs.readFileSync(path.join(__dirname, 'tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const found = new Map<string, Map<string, string>>();
  const open: string[] = [];
  let text = '';
  for (const char of css) {
    if (char === '{') {
      open.push(text.slice(text.lastIndexOf(';') + 1).trim());
      text = '';
    } else if (char === '}') {
      const properties = new Map<string, string>();
      for (const declaration of text.split(';')) {
        const colon = declaration.indexOf(':');
        if (declaration.trim().startsWith('--')) properties.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim());
      }
      const selector = open.join(' ');
      open.pop();
      if (properties.size > 0) found.set(selector, properties);
      text = '';
    } else {
      text += char;
    }
  }
  return found;
}

const RULES = rules();
const ROOT = RULES.get(':root')!;
const DARK = [...RULES.keys()].filter((selector) => selector.includes('dark'));
const SCHEMES = [...RULES.keys()].filter((selector) => selector.startsWith(':root[data-accent='));
/** Tokens with a light and a dark value, without the -l. */
const PAIRED = [...ROOT.keys()].filter((name) => name.endsWith('-l')).map((name) => name.slice(0, -2));

describe('tokens.css', () => {
  it('gives every colour that changes with the mode a light and a dark value, and picks one in each mode', () => {
    expect(DARK).toEqual(["@media (prefers-color-scheme: dark) :root:not([data-theme='light'])", ":root[data-theme='dark']"]);
    expect(PAIRED.length).toBeGreaterThan(30);
    for (const name of ROOT.keys()) {
      if (name.endsWith('-d')) expect(ROOT.has(`${name.slice(0, -2)}-l`), name).toBe(true);
    }
    for (const name of PAIRED) {
      expect(ROOT.has(`${name}-d`), name).toBe(true);
      expect(ROOT.get(name), name).toBe(`var(${name}-l)`);
      for (const dark of DARK) expect(RULES.get(dark)!.get(name), `${name} in ${dark}`).toBe(`var(${name}-d)`);
    }
  });

  it('has one block per colour scheme, in the colour of its swatch, which only changes values that exist', () => {
    const ids = ACCENTS.map((accent) => accent.id).filter((id) => id !== 'green');
    expect(SCHEMES).toEqual(ids.map((id) => `:root[data-accent='${id}']`));
    for (const accent of ACCENTS.filter((choice) => choice.id !== 'mono')) {
      const values = accent.id === 'green' ? ROOT : RULES.get(`:root[data-accent='${accent.id}']`)!;
      expect(accent.swatch, accent.id).toBe(values.get('--accent-l'));
    }
    for (const scheme of SCHEMES) {
      for (const name of RULES.get(scheme)!.keys()) {
        // A scheme sets the -l and -d values (or a value that does not change with the mode), never the value a mode picks.
        expect(ROOT.has(name), `${name} in ${scheme}`).toBe(true);
        expect(PAIRED.includes(name), `${name} in ${scheme}`).toBe(false);
      }
    }
  });

  it('draws the logo in green in the colours of logo-pixels.json, which the favicon and logo files use', () => {
    const colours: Record<string, string> = PIXELS.colours;
    const dark: Record<string, string> = PIXELS.dark;
    for (const key of 'KRIAGHD') {
      expect(ROOT.get(`--logo-${key}-l`), key).toBe(colours[key]);
      expect(ROOT.get(`--logo-${key}-d`), key).toBe(dark[key] ?? colours[key]);
    }
    for (const key of 'LW') expect(ROOT.get(`--logo-${key}`), key).toBe(colours[key]);
  });
});
