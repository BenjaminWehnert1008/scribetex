/**
 * Static analysis of LaTeX sources: which file is the root document, which
 * project files it pulls in, and the document outline.
 *
 * This is deliberately a scanner and not a parser. It does not expand macros,
 * so it can be wrong about generated file names; everything downstream treats
 * its output as a hint. The compile step sends the whole project to the engine
 * anyway, so a missed dependency cannot break a build. What this is used for:
 * picking the main file, warning about a figure that is referenced but absent,
 * and showing the outline.
 */
import { dirname, extname, foldCase, joinPath, normalizePath } from '../paths';
import type { Path } from '../types';

/** Strips comments, respecting \% and verbatim-ish environments. */
export function stripComments(source: string): string {
  let out = '';
  let inVerbatim: string | null = null;
  for (const line of source.split('\n')) {
    if (inVerbatim) {
      out += `${line}\n`;
      if (new RegExp(`\\\\end\\{${inVerbatim}\\*?\\}`).test(line)) inVerbatim = null;
      continue;
    }
    const begin = /\\begin\{(verbatim|lstlisting|minted|Verbatim|comment|filecontents)\*?\}/.exec(line);
    if (begin) {
      inVerbatim = begin[1]!;
      out += `${line}\n`;
      continue;
    }
    let cut = -1;
    for (let i = 0; i < line.length; i++) {
      if (line[i] !== '%') continue;
      let backslashes = 0;
      for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) backslashes++;
      if (backslashes % 2 === 0) {
        cut = i;
        break;
      }
    }
    out += `${cut === -1 ? line : line.slice(0, cut)}\n`;
  }
  return out;
}

/** True when the source looks like a root document rather than an included part. */
export function isRootDocument(source: string): boolean {
  const clean = stripComments(source);
  return /\\documentclass\s*(\[[^\]]*\])?\s*\{/.test(clean) && /\\begin\s*\{document\}/.test(clean);
}

export interface DependencyRef {
  /** The command that produced the reference, e.g. 'input' or 'includegraphics'. */
  command: string;
  /** The argument as written in the source. */
  raw: string;
  /** Project path this resolved to, or null when nothing matched. */
  resolved: Path | null;
  /** Line in the scanned file, 1-based. */
  line: number;
}

const COMMANDS: { name: string; extensions: string[]; multiple?: boolean }[] = [
  { name: 'input', extensions: ['.tex', ''] },
  { name: 'include', extensions: ['.tex', ''] },
  { name: 'subfile', extensions: ['.tex', ''] },
  { name: 'subfileinclude', extensions: ['.tex', ''] },
  { name: 'import', extensions: ['.tex', ''] },
  { name: 'includeonly', extensions: ['.tex', ''], multiple: true },
  { name: 'includegraphics', extensions: ['', '.pdf', '.png', '.jpg', '.jpeg', '.eps', '.svg'] },
  { name: 'bibliography', extensions: ['.bib'], multiple: true },
  { name: 'addbibresource', extensions: ['.bib', ''] },
  { name: 'bibliographystyle', extensions: ['.bst'] },
  { name: 'usepackage', extensions: ['.sty'], multiple: true },
  { name: 'RequirePackage', extensions: ['.sty'], multiple: true },
  { name: 'documentclass', extensions: ['.cls'] },
  { name: 'lstinputlisting', extensions: [''] },
  { name: 'verbatiminput', extensions: [''] },
  { name: 'includepdf', extensions: ['.pdf', ''] },
  { name: 'input@path', extensions: [''] },
];

/**
 * Finds the project files referenced by one source file.
 * `graphicsPaths` extends the search for \includegraphics, as \graphicspath does.
 */
export function scanDependencies(
  source: string,
  options: { from: Path; files: Iterable<Path>; graphicsPaths?: Path[] },
): DependencyRef[] {
  const clean = stripComments(source);
  const index = new Map<string, Path>();
  for (const file of options.files) index.set(foldCase(file), file);
  const baseDir = dirname(options.from);
  const graphicsPaths = options.graphicsPaths ?? parseGraphicsPaths(clean);

  const resolve = (raw: string, extensions: string[], command: string): Path | null => {
    const candidates: string[] = [];
    const searchDirs = command === 'includegraphics' ? ['', baseDir, ...graphicsPaths] : ['', baseDir];
    for (const dir of searchDirs) {
      for (const ext of extensions) {
        const name = raw.endsWith(ext) && ext !== '' ? raw : raw + ext;
        candidates.push(dir === '' ? name : `${dir}/${name}`);
      }
    }
    for (const candidate of candidates) {
      let normalized: string;
      try {
        normalized = normalizePath(candidate);
      } catch {
        continue;
      }
      const hit = index.get(foldCase(normalized));
      if (hit) return hit;
    }
    return null;
  };

  const refs: DependencyRef[] = [];
  const lines = clean.split('\n');
  for (const spec of COMMANDS) {
    const pattern = new RegExp(`\\\\${spec.name}\\s*(?:\\[[^\\]]*\\])?\\s*\\{([^{}]*)\\}`, 'g');
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      for (const match of lines[lineIndex]!.matchAll(pattern)) {
        const argument = match[1]!.trim();
        if (argument === '') continue;
        const parts = spec.multiple ? argument.split(',').map((p) => p.trim()) : [argument];
        for (const part of parts) {
          if (part === '' || part.includes('\\')) continue;
          refs.push({
            command: spec.name,
            raw: part,
            resolved: resolve(part, spec.extensions, spec.name),
            line: lineIndex + 1,
          });
        }
      }
    }
  }
  return refs.sort((a, b) => a.line - b.line || a.raw.localeCompare(b.raw));
}

/** Directories listed in \graphicspath{{a/}{b/}}. */
export function parseGraphicsPaths(source: string): Path[] {
  const match = /\\graphicspath\s*\{((?:\s*\{[^{}]*\}\s*)+)\}/.exec(source);
  if (!match) return [];
  const out: Path[] = [];
  for (const inner of match[1]!.matchAll(/\{([^{}]*)\}/g)) {
    const raw = inner[1]!.trim().replace(/\/+$/, '').replace(/^\.\//, '');
    if (raw === '') continue;
    try {
      out.push(normalizePath(raw));
    } catch {
      /* ignore paths outside the project */
    }
  }
  return out;
}

/**
 * Picks the root document. Preference order:
 *  1. a \documentclass file that nothing else includes (a real root);
 *  2. any \documentclass file, preferring shallow paths and the name "main";
 *  3. null, when the project has no .tex file with a document body.
 */
export function detectMainFile(
  sources: Map<Path, string>,
  options: { files?: Iterable<Path> } = {},
): Path | null {
  const files = [...(options.files ?? sources.keys())];
  const roots = [...sources.entries()].filter(([path, source]) => extname(path) === '.tex' && isRootDocument(source));
  if (roots.length === 0) return null;

  const included = new Set<string>();
  for (const [path, source] of sources) {
    for (const ref of scanDependencies(source, { from: path, files })) {
      if (['input', 'include', 'subfile', 'subfileinclude', 'import'].includes(ref.command) && ref.resolved) {
        included.add(ref.resolved);
      }
    }
  }

  const score = (path: Path): number => {
    let value = 0;
    if (!included.has(path)) value -= 1000;
    value += path.split('/').length * 10;
    const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
    if (name === 'main.tex') value -= 5;
    else if (['thesis.tex', 'document.tex', 'paper.tex', 'report.tex', 'index.tex'].includes(name)) value -= 3;
    return value;
  };
  return roots.map(([path]) => path).sort((a, b) => score(a) - score(b) || a.localeCompare(b))[0]!;
}

export interface OutlineItem {
  level: number;
  /** 'chapter', 'section', … or 'label' for a \label target. */
  kind: string;
  title: string;
  /** 1-based line in the file it was found in. */
  line: number;
  file: Path;
  starred: boolean;
}

const SECTION_LEVELS: Record<string, number> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  subparagraph: 6,
  frametitle: 2,
};

/** Headings in one file, for the outline pane. */
export function scanOutline(source: string, file: Path): OutlineItem[] {
  const lines = stripComments(source).split('\n');
  const out: OutlineItem[] = [];
  const pattern = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph|frametitle)(\*)?\s*(?:\[[^\]]*\])?\s*\{/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const match of line.matchAll(pattern)) {
      const title = readBalanced(line, match.index + match[0].length - 1);
      out.push({
        level: SECTION_LEVELS[match[1]!]!,
        kind: match[1]!,
        title: cleanTitle(title ?? ''),
        line: i + 1,
        file,
        starred: match[2] === '*',
      });
    }
  }
  return out;
}

/** Reads a brace group starting at `open` (the index of "{"). */
function readBalanced(text: string, open: number): string | null {
  if (text[open] !== '{') return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{' && text[i - 1] !== '\\') depth++;
    else if (text[i] === '}' && text[i - 1] !== '\\') {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return text.slice(open + 1);
}

/** Turns "\\textbf{Big} title~here" into "Big title here" for display. */
export function cleanTitle(title: string): string {
  return title
    .replace(/\\(?:textbf|textit|emph|texttt|textsc|mbox|text)\s*\{([^{}]*)\}/g, '$1')
    .replace(/\\[a-zA-Z@]+\s*/g, '')
    .replace(/[{}]/g, '')
    .replace(/~/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Labels defined in a file, used to offer completions for \ref. */
export function scanLabels(source: string): { name: string; line: number }[] {
  const lines = stripComments(source).split('\n');
  const out: { name: string; line: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    for (const match of lines[i]!.matchAll(/\\label\s*\{([^{}]+)\}/g)) {
      out.push({ name: match[1]!.trim(), line: i + 1 });
    }
  }
  return out;
}

/** Citation keys defined in a .bib file, used to offer completions for \cite. */
export function scanBibKeys(bib: string): { key: string; title: string | null; line: number }[] {
  const lines = bib.split('\n');
  const out: { key: string; title: string | null; line: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*@\s*[A-Za-z]+\s*[{(]\s*([^,\s{}()]+)\s*,?/.exec(lines[i]!);
    if (!match) continue;
    let title: string | null = null;
    for (let j = i + 1; j < Math.min(i + 30, lines.length); j++) {
      if (/^\s*@/.test(lines[j]!)) break;
      const field = /^\s*title\s*=\s*[{"]?(.*?)[}"]?\s*,?\s*$/i.exec(lines[j]!);
      if (field) {
        title = field[1]!.replace(/[{}]/g, '').trim() || null;
        break;
      }
    }
    out.push({ key: match[1]!, title, line: i + 1 });
  }
  return out;
}

/**
 * Which bibliography tool the project needs. `biblatex` with `backend=biber`
 * needs biber; plain \bibliography needs bibtex.
 */
export function detectBibTool(source: string): 'biber' | 'bibtex' | null {
  const clean = stripComments(source);
  const biblatex = /\\usepackage\s*(\[[^\]]*\])?\s*\{biblatex\}/.exec(clean);
  if (biblatex) {
    const options = biblatex[1] ?? '';
    if (/backend\s*=\s*bibtex8?/.test(options)) return 'bibtex';
    return 'biber';
  }
  if (/\\(bibliography|bibliographystyle)\s*\{/.test(clean)) return 'bibtex';
  return null;
}

/** True when the document needs \makeindex handling. */
export function needsMakeIndex(source: string): boolean {
  const clean = stripComments(source);
  return /\\makeindex\b/.test(clean) && /\\printindex\b|\\index\s*\{/.test(clean);
}

/** Files that the compiler produces and that should not be mirrored or committed. */
const ARTIFACT_EXTENSIONS = new Set([
  '.aux', '.log', '.out', '.toc', '.lof', '.lot', '.lol', '.bbl', '.blg', '.bcf', '.run.xml', '.idx',
  '.ind', '.ilg', '.glo', '.gls', '.glg', '.nav', '.snm', '.vrb', '.fls', '.fdb_latexmk', '.synctex',
  '.synctex.gz', '.xdv', '.dvi', '.spl', '.pytxcode',
]);

export function isBuildArtifact(path: Path): boolean {
  if (path.endsWith('.synctex.gz') || path.endsWith('.run.xml')) return true;
  return ARTIFACT_EXTENSIONS.has(extname(path));
}

/** The output PDF path for a main file: 'chapters/main.tex' gives 'chapters/main.pdf'. */
export function outputPdfPath(mainFile: Path): Path {
  const dir = dirname(mainFile);
  const name = mainFile.slice(mainFile.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
  return joinPath(dir, `${name}.pdf`);
}
