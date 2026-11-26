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
