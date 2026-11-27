// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { readAccent, saveAccent, nextTheme, readTheme, saveTheme } from './theme';

describe('theme', () => {
  afterEach(() => {
    saveTheme('system');
    saveAccent('green');
  });

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

  it('defaults to the green scheme and remembers another one', () => {
    expect(readAccent()).toBe('green');
    expect(document.documentElement.dataset.accent).toBeUndefined();
    saveAccent('violet');
    expect(readAccent()).toBe('violet');
    expect(document.documentElement.dataset.accent).toBe('violet');
    saveAccent('green');
    expect(readAccent()).toBe('green');
    expect(document.documentElement.dataset.accent).toBeUndefined();
  });

  it('ignores an unknown stored scheme', () => {
    localStorage.setItem('scribetex:accent', 'plaid');
    expect(readAccent()).toBe('green');
  });
});
