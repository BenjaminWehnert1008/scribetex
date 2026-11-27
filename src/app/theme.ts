/**
 * Light or dark mode. "system" (the default) follows the operating system;
 * "light" and "dark" set data-theme on <html>, which tokens.css reads.
 * The choice is kept in this browser only.
 */
export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'scribetex:theme';
const CHOICES: readonly ThemeChoice[] = ['system', 'light', 'dark'];

export function readTheme(): ThemeChoice {
  try {
    const stored = localStorage.getItem(KEY);
    return CHOICES.includes(stored as ThemeChoice) ? (stored as ThemeChoice) : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') delete root.dataset.theme;
  else root.dataset.theme = choice;
}

export function saveTheme(choice: ThemeChoice): void {
  applyTheme(choice);
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // Storage can be blocked; the choice then lasts until the page closes.
  }
}

/** The next choice when the switch is clicked: system, light, dark, system, ... */
export function nextTheme(choice: ThemeChoice): ThemeChoice {
  return CHOICES[(CHOICES.indexOf(choice) + 1) % CHOICES.length];
}

/**
 * The accent colour scheme. Green is the default and sets no attribute; the
 * others set data-accent on <html>, which tokens.css reads. It combines with
 * any mode. Kept in this browser only, like the mode.
 */
export type AccentChoice = 'green' | 'blue' | 'violet' | 'rose' | 'copper' | 'mono';

export const ACCENTS: readonly { id: AccentChoice; label: string; swatch: string }[] = [
  { id: 'green', label: 'Green', swatch: '#17715b' },
  { id: 'blue', label: 'Blue', swatch: '#2457a6' },
  { id: 'violet', label: 'Violet', swatch: '#6a3fa0' },
  { id: 'rose', label: 'Rose', swatch: '#a8324f' },
  { id: 'copper', label: 'Copper', swatch: '#a84a1c' },
  { id: 'mono', label: 'Black and white', swatch: 'linear-gradient(135deg, #1a1a1a 50%, #ffffff 50%)' },
];

const ACCENT_KEY = 'scribetex:accent';

export function readAccent(): AccentChoice {
  try {
    const stored = localStorage.getItem(ACCENT_KEY);
    return ACCENTS.some((accent) => accent.id === stored) ? (stored as AccentChoice) : 'green';
  } catch {
    return 'green';
  }
}

export function applyAccent(choice: AccentChoice): void {
  const root = document.documentElement;
  if (choice === 'green') delete root.dataset.accent;
  else root.dataset.accent = choice;
}

export function saveAccent(choice: AccentChoice): void {
  applyAccent(choice);
  try {
    if (choice === 'green') localStorage.removeItem(ACCENT_KEY);
    else localStorage.setItem(ACCENT_KEY, choice);
  } catch {
    // Storage can be blocked; the choice then lasts until the page closes.
  }
}
