/**
 * Turns a TeX log into diagnostics the editor can jump to.
 *
 * TeX reports problems in three different shapes, and which one you get
 * depends on the flags the engine was run with:
 *
 *   -file-line-error    ./chapters/intro.tex:12: Undefined control sequence.
 *   default             ! Undefined control sequence.      followed by  l.12 \foo
 *   warnings            LaTeX Warning: Reference `fig:x' undefined on input line 12.
 *
 * Only the first form names the file directly. For the other two the file has
 * to be recovered from the parentheses TeX prints when it opens and closes a
 * file: "(./chapters/intro.tex ... )". That bookkeeping is what makes an error
 * inside an \input-ed chapter land on the right line of the right file.
 */
import { normalizePath } from '../paths';
import type { Diagnostic, DiagnosticSeverity, Path } from '../types';

export interface ParseLogOptions {
  /**
   * Paths that exist in the project, used to resolve the names TeX prints
   * ("./chapters/intro.tex", "chapters/intro", "intro.tex") to real paths.
   */
  knownPaths?: Iterable<Path>;
  /** Directory the engine compiled in, when it is not the project root. */
  workDir?: Path;
  /** Include "Overfull \hbox" style typesetting notes. Off by default: they are noisy. */
  includeBadBoxes?: boolean;
  /** Width TeX wrapped the log at (`max_print_line`). 0 disables unwrapping. */
  wrapWidth?: number;
}

export interface LogSummary {
  diagnostics: Diagnostic[];
  /** True when the log contains a fatal error, whether or not a PDF was produced. */
  hasErrors: boolean;
  errorCount: number;
  warningCount: number;
  /** Pages reported by the engine ("Output written on main.pdf (12 pages, ...)"). */
  pages: number | null;
  /** Names of files TeX could not find, for a "missing package" hint in the UI. */
  missingFiles: string[];
}

const DEFAULT_WRAP = 79;

/**
 * Undoes TeX's hard wrapping. TeX breaks log lines at exactly `max_print_line`
 * characters with no continuation marker, so a line of exactly that length is
 * joined with the next one. Done only when such lines actually occur, to avoid
 * mangling logs from engines that do not wrap.
 */
export function unwrapLog(log: string, width = DEFAULT_WRAP): string[] {
  const lines = log.split(/\r\n|\r|\n/);
  if (width <= 0 || !lines.some((line) => line.length === width)) return lines;
  const out: string[] = [];
  let buffer: string | null = null;
  for (const line of lines) {
    buffer = buffer === null ? line : buffer + line;
    if (line.length === width) continue;
    out.push(buffer);
    buffer = null;
  }
  if (buffer !== null) out.push(buffer);
  return out;
}

/** Resolves a file name from the log to a project path. */
export class PathResolver {
  readonly #byPath = new Set<string>();
  readonly #byName = new Map<string, Path[]>();
  readonly #workDir: Path;

  constructor(knownPaths: Iterable<Path> = [], workDir: Path = '') {
    this.#workDir = workDir;
    for (const path of knownPaths) {
      this.#byPath.add(path.toLowerCase());
      const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
      const list = this.#byName.get(name) ?? [];
      list.push(path);
      this.#byName.set(name, list);
      this.#byName.set(name, list);
    }
  }

  resolve(raw: string): Path | null {
    let candidate = raw.trim().replace(/^"|"$/g, '').replace(/\\/g, '/');
    if (candidate === '') return null;
    candidate = candidate.replace(/^\.\//, '');
    // An absolute path from the engine's virtual file system, e.g. "/work/main.tex".
    candidate = candidate.replace(/^\/+(work|home|tmp)\/?/i, '').replace(/^\/+/, '');
    const withWorkDir = this.#workDir && !candidate.startsWith(`${this.#workDir}/`)
      ? `${this.#workDir}/${candidate}`
      : candidate;

    for (const option of [candidate, withWorkDir]) {
      if (this.#byPath.has(option.toLowerCase())) return this.#normalize(option);
      // TeX often drops the extension: "chapters/intro" for "chapters/intro.tex".
      for (const ext of ['.tex', '.sty', '.cls', '.bib']) {
        if (this.#byPath.has((option + ext).toLowerCase())) return this.#normalize(option + ext);
      }
    }
    // Fall back to a unique match on the bare file name.
    const name = candidate.slice(candidate.lastIndexOf('/') + 1).toLowerCase();
    const matches = this.#byName.get(name);
    if (matches?.length === 1) return matches[0]!;
    if (this.#byPath.size === 0) return this.#normalize(candidate);
    return null;
  }

  #normalize(path: string): Path | null {
    try {
      return normalizePath(path);
    } catch {
      return null;
    }
  }
}

// `(./chapters/intro.tex` — TeX prints this when it starts reading a file.
// Anchored: it is applied at the position of each "(" found while scanning.
const FILE_OPEN_AT = /^\((\.?\.?\/?[^()\s{}]*\.(?:tex|ltx|sty|cls|clo|def|cfg|fd|bbl|aux|tikz|pgf|bib|ldf|lco))/i;
const FILE_LINE_ERROR = /^(?:\.\/)?([^:\n]+?\.[A-Za-z0-9]{1,5}):(\d+):\s*(.*)$/;
const TEX_ERROR = /^!\s*(.*)$/;
const LINE_MARK = /^l\.(\d+)\s?(.*)$/;
const LATEX_WARNING = /^(?:(LaTeX|Package|Class|Module)\s+(?:([\w@.-]+)\s+)?)?(Warning|Info):\s*(.*)$/;
const ON_INPUT_LINE = /on (?:input )?line (\d+)/i;
const BAD_BOX = /^(Overfull|Underfull)\s+\\([hv])box\s*\(([^)]*)\)\s*(?:in paragraph |in alignment |detected )?at lines? (\d+)(?:--(\d+))?/;
const MISSING_FILE = /(?:File|Font|Package)\s*[`'"]([^'"]+)['"]?\s*not found/i;
const OUTPUT_PAGES = /Output written on\s+\S+\s+\((\d+)\s+pages?/;
const NO_PAGES = /^No pages of output/;

/** Parses a TeX log into diagnostics, newest state of the file stack respected. */
export function parseLog(log: string, options: ParseLogOptions = {}): LogSummary {
  const lines = unwrapLog(log, options.wrapWidth ?? DEFAULT_WRAP);
  const resolver = new PathResolver(options.knownPaths ?? [], options.workDir ?? '');
  const diagnostics: Diagnostic[] = [];
  const missingFiles: string[] = [];
  const stack: (Path | null)[] = [];
  let pages: number | null = null;

  const currentFile = (): Path | null => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i]) return stack[i]!;
    return null;
  };

  const push = (
    severity: DiagnosticSeverity,
    message: string,
    file: Path | null,
    line: number | null,
    raw: string,
    context: string | null = null,
  ): void => {
    const text = message.trim();
    if (text === '') return;
    diagnostics.push({ severity, message: text, file, line, context, raw: raw.trim() });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // --- file stack -------------------------------------------------------
    // The file a diagnostic belongs to is the one open when the line started:
    // TeX prints ")" after the content of a file, and messages contain plenty
    // of their own parentheses, so the stack is updated after interpreting.
    const fileHere = currentFile();
    trackParens(line, stack, resolver);

    const pageMatch = OUTPUT_PAGES.exec(line);
    if (pageMatch) pages = Number(pageMatch[1]);
    else if (NO_PAGES.test(line)) pages = 0;

    const missing = MISSING_FILE.exec(line);
    if (missing && !missingFiles.includes(missing[1]!)) missingFiles.push(missing[1]!);

    // --- errors -----------------------------------------------------------
    // "./chapters/intro.tex:12: Undefined control sequence."
    const fileLine = FILE_LINE_ERROR.exec(line);
    if (fileLine && !/^(Package|Class|LaTeX|Module)\b/.test(line)) {
      const [, file, lineNo, rest] = fileLine;
      const severity: DiagnosticSeverity = /^\s*(LaTeX |Package |Class )?Warning/i.test(rest!) ? 'warning' : 'error';
      push(severity, stripMarker(rest!) || 'TeX error', resolver.resolve(file!), Number(lineNo), line, lookAheadContext(lines, i));
      continue;
    }

    // "! Undefined control sequence." with the line number a few lines later.
    const error = TEX_ERROR.exec(line);
    if (error) {
      let message = error[1]!.trim();
      let lineNo: number | null = null;
      let context: string | null = null;
      let raw = line;
      for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
        const follow = lines[j]!;
        raw += `\n${follow}`;
        const mark = LINE_MARK.exec(follow);
        if (mark) {
          lineNo = Number(mark[1]);
          context = mark[2]?.trim() || null;
          break;
        }
        if (/^!/.test(follow)) break;
        if (!message.endsWith('.') && follow.trim() !== '' && message.length < 200) {
          message += ` ${follow.trim()}`;
        }
      }
      push('error', message, fileHere, lineNo, raw, context);
      continue;
    }

    // --- warnings and info ------------------------------------------------
    const warning = LATEX_WARNING.exec(line);
    if (warning) {
      const [, source, pkg, kind, rest] = warning;
      let message = rest!.trim();
      // LaTeX wraps a warning body onto following indented lines.
      for (let j = i + 1; j < lines.length; j++) {
        const follow = lines[j]!;
        if (!/^\s{2,}\S/.test(follow) || /^\s*\(/.test(follow)) break;
        message += ` ${follow.trim()}`;
        i = j;
      }
      const lineMatch = ON_INPUT_LINE.exec(message);
      const label = source ? `${source}${pkg ? ` ${pkg}` : ''}: ` : '';
      push(
        kind === 'Warning' ? 'warning' : 'info',
        label + message,
        fileHere,
        lineMatch ? Number(lineMatch[1]) : null,
        line,
      );
      continue;
    }

    // --- bad boxes --------------------------------------------------------
    const badBox = BAD_BOX.exec(line);
    if (badBox && options.includeBadBoxes) {
      const [, kind, box, detail, from] = badBox;
      push('info', `${kind} \\${box}box (${detail})`, fileHere, Number(from), line);
    }
  }

  const errorCount = diagnostics.filter((d) => d.severity === 'error').length;
  return {
    diagnostics,
    hasErrors: errorCount > 0,
    errorCount,
    warningCount: diagnostics.filter((d) => d.severity === 'warning').length,
    pages,
    missingFiles,
  };
}

function stripMarker(text: string): string {
  return text.replace(/^!\s*/, '').trim();
}

/**
 * Updates the file stack for one log line, walking its parentheses in order.
 * A "(" that is not followed by a file name pushes an anonymous level, so that
 * the ")" of something like "(12.34pt too wide)" closes that level instead of
 * wrongly closing the file TeX is reading.
 */
function trackParens(line: string, stack: (Path | null)[], resolver: PathResolver): void {
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '(') {
      const match = FILE_OPEN_AT.exec(line.slice(i));
      if (match) {
        stack.push(resolver.resolve(match[1]!));
        i += match[0].length - 1;
      } else {
        stack.push(null);
      }
    } else if (char === ')') {
      stack.pop();
    }
  }
}

/** The source excerpt from a following "l.NN" line, if there is one nearby. */
function lookAheadContext(lines: string[], from: number): string | null {
  for (let j = from + 1; j < Math.min(from + 6, lines.length); j++) {
    const mark = LINE_MARK.exec(lines[j]!);
    if (mark) return mark[2]?.trim() || null;
    if (/^!/.test(lines[j]!)) break;
  }
  return null;
}

/**
 * A short, plain-language headline for a diagnostic, so the problems list reads
 * like sentences instead of TeX jargon. Returns `null` when nothing is known
 * about this error, and the raw message should be shown.
 */
export function explain(diagnostic: Diagnostic): { headline: string; hint: string } | null {
  const message = diagnostic.message;
  const rules: { test: RegExp; headline: (m: RegExpExecArray) => string; hint: string }[] = [
    {
      test: /Undefined control sequence/i,
      headline: () => 'Unknown command',
      hint: 'TeX does not know this command. Check the spelling, or load the package that defines it.',
    },
    {
      test: /File [`'"]([^'"]+)['"]? not found/i,
      headline: (m) => `Missing file: ${m[1]}`,
      hint: 'The document asks for a file that is not in the project and not in the bundled TeX packages.',
    },
    {
      test: /Missing [$] inserted/i,
      headline: () => 'Math outside math mode',
      hint: 'Something that only works in math mode is used in text. Wrap it in $ … $.',
    },
    {
      test: /Missing \\?\{?(\}|\{) inserted/i,
      headline: () => 'Unbalanced braces',
      hint: 'A { or } is missing. The line shown is where TeX noticed, not always where it started.',
    },
    {
      test: /Runaway argument|File ended while scanning/i,
      headline: () => 'Something was never closed',
      hint: 'An environment, group or argument was opened and not closed before the file ended.',
    },
    {
      test: /Environment ([\w*-]+) undefined/i,
      headline: (m) => `Unknown environment: ${m[1]}`,
      hint: 'No package in the document defines this environment.',
    },
    {
      test: /Reference [`'"]([^'"]+)['"]? (?:on page \d+ )?undefined/i,
      headline: (m) => `Reference not found: ${m[1]}`,
      hint: 'There is no \\label with this name, or the document needs another compile pass.',
    },
    {
      test: /Citation [`'"]([^'"]+)['"]? (?:on page \d+ )?undefined/i,
      headline: (m) => `Citation not found: ${m[1]}`,
      hint: 'The key is missing from the .bib file, or the bibliography has not been built yet.',
    },
    {
      test: /There were undefined references/i,
      headline: () => 'Some references are still undefined',
      hint: 'Compile again so labels and citations can be resolved.',
    },
    {
      test: /Label [`'"]([^'"]+)['"]? multiply defined/i,
      headline: (m) => `Label used twice: ${m[1]}`,
      hint: 'Two \\label commands share a name, so references to it point at one of them.',
    },
    {
      test: /Unicode character|not set up for use with LaTeX/i,
      headline: () => 'Character the font cannot print',
      hint: 'Load the right input encoding, or compile with XeLaTeX or LuaLaTeX.',
    },
    {
      test: /Dimension too large|Arithmetic overflow/i,
      headline: () => 'A size is out of range',
      hint: 'A length or a picture coordinate is larger than TeX can represent.',
    },
    {
      test: /Emergency stop|Fatal error occurred/i,
      headline: () => 'TeX gave up',
      hint: 'Fix the first error above: everything after it is usually a consequence.',
    },
  ];
  for (const rule of rules) {
    const match = rule.test.exec(message);
    if (match) return { headline: rule.headline(match), hint: rule.hint };
  }
  return null;
}
