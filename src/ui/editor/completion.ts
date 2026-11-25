/**
 * Completion for LaTeX source: commands, environments, and the names that
 * only this project knows (labels, citation keys, files).
 */
import { type Completion, type CompletionContext, type CompletionResult, snippetCompletion } from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import type { ProjectIndex } from '@/app/project-index';
import { dirname, extname } from '@/core/paths';
import type { Path } from '@/core/types';
import { COMMANDS, ENVIRONMENT_BODIES, ENVIRONMENTS } from './latex-data';

export interface CompletionSources {
  index(): ProjectIndex | null;
  /** Folder TeX runs in, which file names in the source are relative to. */
  workDir(): Path;
}

const commandOptions: Completion[] = COMMANDS.map((command) =>
  command.snippet
    ? snippetCompletion(`\\${command.snippet}`, { label: `\\${command.name}`, detail: command.detail, type: 'keyword' })
    : { label: `\\${command.name}`, detail: command.detail, type: 'keyword' },
);

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.pdf', '.eps', '.svg']);

/** How a project file is written inside `\input{}` and friends. */
function relativeTo(workDir: Path, file: Path): string {
  if (workDir === '') return file;
  if (file.startsWith(`${workDir}/`)) return file.slice(workDir.length + 1);
  const up = workDir.split('/').map(() => '..');
  return [...up, file].join('/');
}

function fileOptions(command: string, sources: CompletionSources): Completion[] {
  const index = sources.index();
  if (!index) return [];
  const workDir = sources.workDir();
  const keep = (file: Path): string | null => {
    const ext = extname(file).toLowerCase();
    const written = relativeTo(workDir, file);
    switch (command) {
      case 'input':
      case 'include':
      case 'subfile':
        return ext === '.tex' ? written.slice(0, -4) : null;
      case 'includegraphics':
        return IMAGE_EXTENSIONS.has(ext) ? written : null;
      case 'includepdf':
        return ext === '.pdf' ? written : null;
      case 'bibliography':
        return ext === '.bib' ? written.slice(0, -4) : null;
      case 'addbibresource':
        return ext === '.bib' ? written : null;
      default:
        return written;
    }
  };
  const options: Completion[] = [];
  for (const file of index.files) {
    const label = keep(file);
    if (label !== null) options.push({ label, type: 'text', detail: dirname(file) || undefined });
  }
  return options;
}

function beginEnvironment(name: string) {
  return (view: EditorView, _completion: Completion, from: number, to: number): void => {
    const closing = view.state.sliceDoc(to, to + 1) === '}' ? 1 : 0;
    const line = view.state.doc.lineAt(from);
    const indent = /^[ \t]*/.exec(line.text)![0];
    const body = (ENVIRONMENT_BODIES[name] ?? '').split('\n').map((text) => `${indent}\t${text}`);
    const head = `${name}}\n`;
    const firstBodyLine = body[0]!;
    const insert = `${head}${body.join('\n')}\n${indent}\\end{${name}}`;
    view.dispatch({
      changes: { from, to: to + closing, insert },
      selection: { anchor: from + head.length + firstBodyLine.length },
      scrollIntoView: true,
      userEvent: 'input.complete',
    });
  };
}

export function latexCompletions(sources: CompletionSources) {
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    let match: RegExpExecArray | null;

    // Inside the braces of a reference: offer the project's labels.
    if ((match = /\\(?!href)(?:[a-zA-Z]*ref|[cC]ref[a-zA-Z]*)\*?\{([^{}]*)$/.exec(before))) {
      const typed = match[1]!.split(',').at(-1)!.trimStart();
      const index = sources.index();
      return {
        from: context.pos - typed.length,
        options: (index?.labels ?? []).map((label) => ({ label: label.name, type: 'variable', detail: `${label.file}:${label.line}` })),
        validFor: /^[^{},\s]*$/,
      };
    }

    // Inside a citation: offer the keys of the .bib files.
    if ((match = /\\[a-zA-Z]*cite[a-zA-Z]*\*?(?:\[[^\]]*\]){0,2}\{([^{}]*)$/.exec(before))) {
      const typed = match[1]!.split(',').at(-1)!.trimStart();
      const index = sources.index();
      return {
        from: context.pos - typed.length,
        options: (index?.bibKeys ?? []).map((item) => ({ label: item.key, type: 'constant', detail: item.title ?? item.file })),
        validFor: /^[^{},\s]*$/,
      };
    }

    // Inside a command that takes a file name.
    if (
      (match = /\\(input|include|subfile|includegraphics|includepdf|bibliography|addbibresource|lstinputlisting)(?:\[[^\]]*\])?\{([^{}]*)$/.exec(before))
    ) {
      const typed = match[2]!.split(',').at(-1)!.trimStart();
      return { from: context.pos - typed.length, options: fileOptions(match[1]!, sources), validFor: /^[^{},]*$/ };
    }

    if ((match = /\\(begin|end)\{([a-zA-Z*]*)$/.exec(before))) {
      const opening = match[1] === 'begin';
      return {
        from: context.pos - match[2]!.length,
        options: ENVIRONMENTS.map((env) => ({
          label: env.name,
          detail: env.detail,
          type: 'type',
          apply: opening ? beginEnvironment(env.name) : undefined,
        })),
        validFor: /^[a-zA-Z*]*$/,
      };
    }

    if ((match = /\\[a-zA-Z@]*$/.exec(before))) {
      if (match[0].length < 2 && !context.explicit) return null;
      return { from: context.pos - match[0].length, options: commandOptions, validFor: /^\\[a-zA-Z@]*$/ };
    }
    return null;
  };
}
