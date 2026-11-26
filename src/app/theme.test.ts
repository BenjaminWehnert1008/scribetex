// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { nextTheme, readTheme, saveTheme } from './theme';

describe('theme', () => {
  afterEach(() => saveTheme('system'));

  it('defaults to the system', () => {
    expect(readTheme()).toBe('system');
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it('remembers a fixed choice and sets data-theme', () => {
    saveTheme('dark');
    expect(readTheme()).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    saveTheme('system');
    expect(readTheme()).toBe('system');
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it('cycles system, light, dark', () => {
    expect(nextTheme('system')).toBe('light');
    expect(nextTheme('light')).toBe('dark');
    expect(nextTheme('dark')).toBe('system');
  });
});
