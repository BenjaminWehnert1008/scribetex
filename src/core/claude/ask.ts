/**
 * "Ask Claude": the question that scribeTex hands to Claude, and the links
 * that open it.
 *
 * scribeTex never talks to Claude itself. It opens the Claude desktop app (or
 * claude.ai) with the question filled in, and the person sends it there with
 * their own Claude plan. When the project is linked to a folder, the app is
 * opened on that folder, so Claude can read and change the files directly;
 * the folder sync brings those changes back into the editor.
 *
 * Link formats: https://support.claude.com/en/articles/14729294 (the app
 * fills in the prompt but does not send it, and cuts it at about 14,000
 * characters).
 */
import type { Diagnostic, Path } from '../types';

/** Below the app's limit of about 14,000 characters, with room for the encoding. */
export const MAX_PROMPT_CHARS = 12_000;
const MAX_LOG_CHARS = 2_500;
const FILE_CONTEXT_LINES = 40;

export interface AskInput {
  question: string;
  projectName: string;
  mainFile: Path | null;
  /** The problem the person asked about, if any. */
  problem: Diagnostic | null;
  /** Further errors of the same compile, for context. */
  otherErrors: Diagnostic[];
  /** The file shown in the editor, with its text. */
  file: { path: Path; text: string; line: number | null } | null;
  /** True when Claude is opened on the linked folder and can read the files itself. */
  viaFolder: boolean;
}

const ENVIRONMENT =
  'scribeTex compiles in the browser with pdfLaTeX and BibTeX (TeX Live 2026). It has no shell escape (so no minted or svg packages) and no biber (biblatex works with backend=bibtex). XeLaTeX and LuaLaTeX are not available.';

function where(diagnostic: Diagnostic): string {
  if (!diagnostic.file) return '';
  return diagnostic.line !== null ? ` (${diagnostic.file}, line ${diagnostic.line})` : ` (${diagnostic.file})`;
}

function describeProblem(diagnostic: Diagnostic): string {
  const lines = [`${diagnostic.severity === 'error' ? 'Error' : 'Warning'}${where(diagnostic)}: ${diagnostic.message}`];
  if (diagnostic.context) lines.push(`TeX stopped here: ${diagnostic.context}`);
  const raw = diagnostic.raw.trim();
  if (raw && raw !== diagnostic.message) lines.push('From the log:', fence(raw.length > MAX_LOG_CHARS ? `${raw.slice(0, MAX_LOG_CHARS)}\n…` : raw));
  return lines.join('\n');
}

function fence(text: string): string {
  // A fence longer than any run of backticks inside, so the text cannot close it.
  const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}\n${text}\n${ticks}`;
}

/** The lines of `text` around `line` (1-based), numbered, or all of it when it is short. */
export function excerpt(text: string, line: number | null, budget: number): { text: string; first: number; last: number; whole: boolean } {
  const lines = text.split('\n');
  const number = (from: number, to: number): string =>
    lines
      .slice(from - 1, to)
      .map((content, index) => `${String(from + index).padStart(4)}  ${content}`)
      .join('\n');
  const all = number(1, lines.length);
  if (all.length <= budget) return { text: all, first: 1, last: lines.length, whole: true };
  const centre = line ?? 1;
  let first = Math.max(1, centre - FILE_CONTEXT_LINES / 2);
  let last = Math.min(lines.length, first + FILE_CONTEXT_LINES - 1);
  first = Math.max(1, last - FILE_CONTEXT_LINES + 1);
  let shown = number(first, last);
  // Long lines: give up context from both ends until it fits.
  while (shown.length > budget && last > first) {
    if (last - centre >= centre - first) last -= 1;
    else first += 1;
    shown = number(first, last);
  }
  return { text: shown.slice(0, budget), first, last, whole: false };
}

/** The text that is put into Claude's message box. Never longer than MAX_PROMPT_CHARS. */
export function buildPrompt(input: AskInput): string {
  const parts: string[] = [];
  const question = input.question.trim();
  parts.push(question === '' ? 'Please help me with this LaTeX project.' : question);

  const about = [`This is about my LaTeX project "${input.projectName}", written in scribeTex.`];
  if (input.mainFile) about.push(`The main file is ${input.mainFile}.`);
  about.push(ENVIRONMENT);
  if (input.viaFolder) {
    about.push(
      'The folder you have open is this project. scribeTex keeps it in step with the editor, so please change the files in the folder directly; scribeTex picks the changes up and compiles again. Please do not rename or move files unless I ask.',
    );
  }
  parts.push(about.join(' '));

  if (input.problem) parts.push(`scribeTex reports this problem:\n${describeProblem(input.problem)}`);
  const others = input.otherErrors.filter((diagnostic) => diagnostic !== input.problem).slice(0, 5);
  if (others.length > 0) {
    parts.push(`Other problems of the same compile:\n${others.map((diagnostic) => `- ${diagnostic.message}${where(diagnostic)}`).join('\n')}`);
  }

  if (input.file) {
    const head = parts.join('\n\n');
    const budget = MAX_PROMPT_CHARS - head.length - 200;
    if (input.viaFolder) {
      const at = input.file.line !== null ? `, at line ${input.file.line}` : '';
      parts.push(`I am looking at ${input.file.path}${at}.`);
    } else if (budget > 400) {
      const shown = excerpt(input.file.text, input.file.line, budget);
      const label = shown.whole ? `The file ${input.file.path}:` : `Lines ${shown.first} to ${shown.last} of ${input.file.path}:`;
      parts.push(`${label}\n${fence(shown.text)}`);
    }
  }

  const prompt = parts.join('\n\n');
  return prompt.length > MAX_PROMPT_CHARS ? `${prompt.slice(0, MAX_PROMPT_CHARS - 1)}…` : prompt;
}

/**
 * Cleans up a folder path as people paste it: Windows' "Copy as path" adds
 * quotes, a file manager may give a file:// address, and a trailing slash does
 * not matter. Returns null for anything that is not an absolute path.
 */
export function normalizeFolderPath(input: string): string | null {
  let path = input.trim().replace(/^["']|["']$/g, '').trim();
  if (/^file:\/\//i.test(path)) {
    try {
      const url = new URL(path);
      path = decodeURIComponent(url.pathname);
      // file:///C:/Users/... has a leading slash before the drive letter.
      if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1).replace(/\//g, '\\');
    } catch {
      return null;
    }
  }
  if (path.length > 1) path = path.replace(/[\\/]+$/, '');
  const unix = path.startsWith('/');
  const windows = /^[A-Za-z]:\\/.test(path) || /^[A-Za-z]:$/.test(path);
  if (!unix && !windows) return null;
  if (path.split(/[\\/]/).includes('..')) return null;
  return path;
}

/** The last part of a folder path, to compare with the name of the linked folder. */
export function folderPathName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Opens the Claude desktop app with the prompt filled in, on the folder when there is one. */
export function claudeAppLink(prompt: string, folderPath: string | null): string {
  // Percent-encoding throughout, as in the documented examples: a "+" for a
  // space is only understood by some parsers.
  const q = `q=${encodeURIComponent(prompt)}`;
  if (folderPath) return `claude://cowork/new?${q}&folder=${encodeURIComponent(folderPath)}`;
  return `claude://claude.ai/new?${q}`;
}

/** claude.ai in the browser. The prompt goes via the clipboard, which works whatever the site supports. */
export const CLAUDE_WEB_URL = 'https://claude.ai/new';
