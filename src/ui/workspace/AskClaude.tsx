import { ExternalLink } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { notify, reportError } from '@/app/services';
import type { WorkspaceModel } from '@/app/workspace-model';
import { buildPrompt, CLAUDE_WEB_URL, claudeAppLink, folderPathName, normalizeFolderPath } from '@/core/claude/ask';
import type { Diagnostic, Path } from '@/core/types';
import { Dialog } from '../common/ui';

export interface AskClaudeProps {
  model: WorkspaceModel;
  /** The problem the person asked about, or null for a question of their own. */
  problem: Diagnostic | null;
  /** All errors and warnings of the latest compile. */
  problems: Diagnostic[];
  /** The linked folder's name, or null when the project has none. */
  folderName: string | null;
  /** The file and line in the editor. */
  activeFile: Path | null;
  cursorLine: number | null;
  onClose: () => void;
}

function defaultQuestion(problem: Diagnostic | null, linked: boolean): string {
  if (!problem) return '';
  if (problem.severity === 'error') return linked ? 'Please fix this error in the project.' : 'Please explain this error and show me how to fix it.';
  return linked ? 'Please look at this warning and fix it if it matters.' : 'Please explain this warning and whether I should fix it.';
}

export function AskClaude(props: AskClaudeProps) {
  const { model, problem, folderName } = props;
  const linked = folderName !== null;
  const [question, setQuestion] = useState(() => defaultQuestion(problem, linked));
  const [pathInput, setPathInput] = useState('');
  const [fileText, setFileText] = useState<{ path: Path; text: string } | null>(null);
  const [copyFallback, setCopyFallback] = useState(false);

  // The file the question is about: the one with the problem, else the one in the editor.
  const filePath = problem?.file ?? props.activeFile;
  const fileLine = problem?.file ? problem.line : props.cursorLine;

  useEffect(() => {
    let live = true;
    void model.claudeFolderPath().then((saved) => {
      if (live && saved) setPathInput((current) => (current === '' ? saved : current));
    });
    return () => {
      live = false;
    };
  }, [model]);

  const readable = filePath !== null && !/\.(pdf|png|jpe?g|gif|svg|eps)$/i.test(filePath);
  useEffect(() => {
    if (!readable || !filePath) return;
    let live = true;
    model
      .readText(filePath)
      .then((text) => {
        if (live) setFileText({ path: filePath, text });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [model, filePath, readable]);
  const shownFile = readable && fileText?.path === filePath ? fileText : null;

  const folderPath = linked ? normalizeFolderPath(pathInput) : null;
  const pathProblem =
    !linked || pathInput.trim() === ''
      ? null
      : folderPath === null
        ? 'This is not a full path. It starts with / on a Mac, or with a drive letter such as C:\\ on Windows.'
        : folderName !== null && folderPathName(folderPath) !== folderName
          ? `This path ends in "${folderPathName(folderPath)}", but the linked folder is called "${folderName}". Check that it is the same folder.`
          : null;
  const viaFolder = folderPath !== null;

  const prompt = useMemo(
    () =>
      buildPrompt({
        question,
        projectName: model.state.get().project.name,
        mainFile: model.mainFile(),
        problem,
        otherErrors: props.problems.filter((diagnostic) => diagnostic.severity === 'error'),
        file: shownFile ? { path: shownFile.path, text: shownFile.text, line: fileLine } : null,
        viaFolder,
      }),
    [question, model, problem, props.problems, shownFile, fileLine, viaFolder],
  );
  const appLink = claudeAppLink(prompt, folderPath);

  const rememberPath = (): void => {
    if (!linked) return;
    void model.setClaudeFolderPath(folderPath).catch((error: unknown) => reportError(error));
  };

  const openInBrowser = async (): Promise<void> => {
    rememberPath();
    let copied = false;
    try {
      await navigator.clipboard.writeText(prompt);
      copied = true;
    } catch {
      setCopyFallback(true);
    }
    window.open(CLAUDE_WEB_URL, '_blank', 'noopener,noreferrer');
    if (copied) {
      notify('Your question is copied. Paste it into Claude with Ctrl+V (Cmd+V on a Mac).');
      props.onClose();
    }
  };

  return (
    <Dialog title="Ask Claude" wide onClose={props.onClose}>
      <p className="muted">
        This opens Claude with your question already written in. You send it there, with your own Claude plan. scribeTeX itself sends nothing to Claude.
      </p>
      <div style={{ display: 'grid', gap: 12, marginTop: 14 }}>
        <label className="stack">
          Your question
          <textarea
            className="field"
            style={{ height: 'auto', minHeight: 72, padding: '8px 10px', resize: 'vertical' }}
            rows={3}
            value={question}
            placeholder="For example: Why is my bibliography empty?"
            onChange={(event) => setQuestion(event.target.value)}
          />
        </label>

        {linked ? (
          <>
            <label className="stack">
              Where the folder &quot;{folderName}&quot; is on this computer
              <input
                className="field mono"
                value={pathInput}
                spellCheck={false}
                autoComplete="off"
                placeholder="/Users/you/Documents/Thesis"
                onChange={(event) => setPathInput(event.target.value)}
                onBlur={rememberPath}
              />
            </label>
            <p className="muted" style={{ fontSize: 12.5, marginTop: -6 }}>
              Browsers do not tell a web page where a folder is, so paste its path once. On a Mac, select the folder in Finder and press Option-Command-C.
              On Windows, hold Shift, right-click the folder and choose &quot;Copy as path&quot;. The path stays in this browser.
            </p>
            {pathProblem && (
              <p role="alert" style={{ color: 'var(--warn)', fontSize: 13 }}>
                {pathProblem}
              </p>
            )}
            <p style={{ fontSize: 13.5 }}>
              {viaFolder
                ? `Claude opens on this folder and can read and change the files. scribeTeX picks up the changes within a few seconds${
                    model.state.get().project.autoCompile ? ' and compiles again.' : '. Press Compile to see them in the PDF.'
                  }`
                : 'Without the path, Claude gets your question and the file you are looking at, but cannot change the files itself.'}
            </p>
          </>
        ) : (
          <p style={{ fontSize: 13.5 }}>
            Claude gets your question and the file you are looking at. To let Claude change the files itself, link this project to a folder first, under
            &quot;Saving and backup&quot;.
          </p>
        )}

        <details>
          <summary className="muted" style={{ cursor: 'pointer', fontSize: 13 }}>
            What Claude gets ({prompt.length.toLocaleString()} characters)
          </summary>
          <pre className="mono" style={{ whiteSpace: 'pre-wrap', fontSize: 12, maxHeight: 220, overflow: 'auto', marginTop: 8, padding: 10, border: '1px solid var(--line)', borderRadius: 6 }}>
            {prompt}
          </pre>
        </details>

        {copyFallback && (
          <label className="stack">
            The browser did not allow copying. Select this text, copy it and paste it into Claude:
            <textarea className="field mono" readOnly style={{ height: 120, padding: 8 }} value={prompt} onFocus={(event) => event.currentTarget.select()} />
          </label>
        )}
      </div>

      <div className="actions">
        <button type="button" className="btn" onClick={props.onClose}>
          Cancel
        </button>
        <button type="button" className="btn" onClick={() => void openInBrowser()}>
          <ExternalLink size={14} /> Use claude.ai in the browser
        </button>
        <a
          className="btn primary"
          href={appLink}
          style={{ textDecoration: 'none' }}
          onClick={() => {
            rememberPath();
            // Closing at once would remove the link before the browser follows it.
            setTimeout(props.onClose, 0);
          }}
        >
          Open in the Claude app
        </a>
      </div>
      <p className="faint" style={{ fontSize: 12, marginTop: 10, textAlign: 'right' }}>
        Nothing happens? The Claude desktop app may not be installed. Use claude.ai in the browser instead.
      </p>
    </Dialog>
  );
}
