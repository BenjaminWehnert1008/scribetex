import { describe, expect, it } from 'vitest';
import type { Diagnostic, Path } from '../types';
import { buildPrompt, claudeAppLink, excerpt, folderPathName, MAX_PROMPT_CHARS, normalizeFolderPath, type AskInput } from './ask';

const p = (path: string): Path => path as Path;

const problem: Diagnostic = {
  severity: 'error',
  message: 'Undefined control sequence.',
  file: p('chapters/intro.tex'),
  line: 12,
  context: 'l.12 \\foo',
  raw: '! Undefined control sequence.\nl.12 \\foo',
};

const base: AskInput = {
  question: 'Why does this fail?',
  projectName: 'Thesis',
  mainFile: p('main.tex'),
  problem: null,
  otherErrors: [],
  file: null,
  viaFolder: false,
};

describe('buildPrompt', () => {
  it('starts with the question and says what the engine can do', () => {
    const prompt = buildPrompt(base);
    expect(prompt.startsWith('Why does this fail?')).toBe(true);
    expect(prompt).toContain('"Thesis"');
    expect(prompt).toContain('The main file is main.tex.');
    expect(prompt).toContain('pdfLaTeX and BibTeX');
    expect(prompt).not.toContain('folder you have open');
  });

  it('asks for a question when none was written', () => {
    expect(buildPrompt({ ...base, question: '  ' }).startsWith('Please help me with this LaTeX project.')).toBe(true);
  });

  it('describes the problem with its file, line and log', () => {
    const prompt = buildPrompt({ ...base, problem });
    expect(prompt).toContain('Error (chapters/intro.tex, line 12): Undefined control sequence.');
    expect(prompt).toContain('TeX stopped here: l.12 \\foo');
    expect(prompt).toContain('From the log:');
  });

  it('lists the other errors once, without repeating the one asked about', () => {
    const other: Diagnostic = { ...problem, message: 'Missing $ inserted.', line: 30 };
    const prompt = buildPrompt({ ...base, problem, otherErrors: [problem, other] });
    expect(prompt).toContain('- Missing $ inserted. (chapters/intro.tex, line 30)');
    expect(prompt.match(/Undefined control sequence/g)).toHaveLength(2); // the headline and the log excerpt
  });

  it('on the folder, names the file instead of copying it, and asks Claude to edit the files', () => {
    const prompt = buildPrompt({ ...base, viaFolder: true, file: { path: p('chapters/intro.tex'), text: 'secret text', line: 12 } });
    expect(prompt).toContain('change the files in the folder directly');
    expect(prompt).toContain('I am looking at chapters/intro.tex, at line 12.');
    expect(prompt).not.toContain('secret text');
  });

  it('without the folder, includes the file with line numbers', () => {
    const prompt = buildPrompt({ ...base, file: { path: p('main.tex'), text: '\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}', line: 3 } });
    expect(prompt).toContain('The file main.tex:');
    expect(prompt).toContain('   3  Hi');
  });

  it('keeps a long file around the line of the problem and stays under the limit', () => {
    const text = Array.from({ length: 5000 }, (_, index) => `line ${index + 1} ${'x'.repeat(60)}`).join('\n');
    const prompt = buildPrompt({ ...base, problem: { ...problem, line: 2500 }, file: { path: p('main.tex'), text, line: 2500 } });
    expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
    expect(prompt).toMatch(/Lines \d+ to \d+ of main.tex:/);
    expect(prompt).toContain('line 2500 ');
    expect(prompt).not.toContain('line 1 x');
  });

  it('cannot be closed early by backticks in the file', () => {
    const prompt = buildPrompt({ ...base, file: { path: p('main.tex'), text: 'a\n```\nb', line: null } });
    expect(prompt).toContain('````\n   1  a');
  });

  it('cuts anything that is still too long', () => {
    const prompt = buildPrompt({ ...base, question: 'q'.repeat(20_000) });
    expect(prompt.length).toBe(MAX_PROMPT_CHARS);
  });
});

describe('excerpt', () => {
  it('returns short text whole', () => {
    expect(excerpt('a\nb', 1, 1000)).toEqual({ text: '   1  a\n   2  b', first: 1, last: 2, whole: true });
  });

  it('centres on the line', () => {
    const text = Array.from({ length: 200 }, (_, index) => `${index + 1}`).join('\n');
    const shown = excerpt(text, 100, 500);
    expect(shown.whole).toBe(false);
    expect(shown.first).toBeLessThanOrEqual(100);
    expect(shown.last).toBeGreaterThanOrEqual(100);
    expect(shown.text.length).toBeLessThanOrEqual(500);
  });
});

describe('normalizeFolderPath', () => {
  it.each([
    ['/Users/anna/Thesis', '/Users/anna/Thesis'],
    ['  /Users/anna/Thesis/  ', '/Users/anna/Thesis'],
    ['"C:\\Users\\Anna\\Thesis"', 'C:\\Users\\Anna\\Thesis'],
    ['C:\\Users\\Anna\\Thesis\\', 'C:\\Users\\Anna\\Thesis'],
    ['file:///Users/anna/My%20Thesis', '/Users/anna/My Thesis'],
    ['file:///C:/Users/Anna/Thesis', 'C:\\Users\\Anna\\Thesis'],
    ['/', '/'],
  ])('accepts %s', (input, expected) => {
    expect(normalizeFolderPath(input)).toBe(expected);
  });

  it.each(['Thesis', '~/Thesis', './Thesis', '', '/Users/anna/../bob', 'https://example.com/x'])('rejects %s', (input) => {
    expect(normalizeFolderPath(input)).toBeNull();
  });
});

describe('folderPathName', () => {
  it('takes the last part on both systems', () => {
    expect(folderPathName('/Users/anna/Thesis')).toBe('Thesis');
    expect(folderPathName('C:\\Users\\Anna\\Thesis')).toBe('Thesis');
  });
});

describe('claudeAppLink', () => {
  it('opens Cowork on the folder', () => {
    const link = claudeAppLink('Fix it & go', '/Users/anna/My Thesis');
    expect(link).toBe('claude://cowork/new?q=Fix%20it%20%26%20go&folder=%2FUsers%2Fanna%2FMy%20Thesis');
  });

  it('opens a new chat without a folder', () => {
    const link = claudeAppLink('Hello world', null);
    expect(link).toBe('claude://claude.ai/new?q=Hello%20world');
    expect(new URL(link).searchParams.get('q')).toBe('Hello world');
  });
});
