// Types only: the converter itself is loaded when a file is imported.
import type { ConvertedProject } from '@/core/docx/import';
import type { ProjectId } from '@/core/types';
import { Dialog } from '../common/ui';

export type WordImport =
  | { state: 'converting'; fileName: string }
  | { state: 'done'; fileName: string; projectId: ProjectId; result: ConvertedProject }
  | { state: 'failed'; fileName: string; message: string };

/** Shows how a Word import is going, and what came out of it. */
export function WordImportDialog(props: { job: WordImport; onClose: () => void; onOpen: (id: ProjectId) => void }) {
  const { job } = props;
  if (job.state === 'converting') {
    return (
      <Dialog key="converting" title="Importing a Word file">
        <p role="status">
          Turning <b>{job.fileName}</b> into a LaTeX project…
        </p>
        <p className="muted fine">This happens in your browser. The file is not uploaded anywhere.</p>
      </Dialog>
    );
  }
  if (job.state === 'failed') {
    return (
      <Dialog key="failed" title="The Word file could not be imported" onClose={props.onClose}>
        <p>{job.message}</p>
        <div className="actions">
          <button className="btn" onClick={props.onClose}>
            Close
          </button>
        </div>
      </Dialog>
    );
  }
  const { result, projectId } = job;
  const counts = describeSummary(result);
  const folder = result.summary.documentClass === 'report' ? 'chapters/' : 'sections/';
  return (
    <Dialog key="done" title="Word file imported" onClose={props.onClose}>
      <p>
        <b>{result.name}</b> is now a LaTeX project. <code>main.tex</code> holds the settings and pulls in the text
        {result.summary.parts > 0 ? (
          <>
            {' '}
            from <code>{folder}</code>, one file per {result.summary.documentClass === 'report' ? 'chapter' : 'section'}
          </>
        ) : null}
        {result.summary.images > 0 ? (
          <>
            ; pictures are in <code>images/</code>
          </>
        ) : null}
        {result.summary.references > 0 ? (
          <>
            ; references are in <code>references.bib</code>
          </>
        ) : null}
        .
      </p>
      {counts.length > 0 && <p className="muted">{counts.join(' · ')}</p>}
      {result.warnings.length > 0 && (
        <div className="notice-card warn" role="note" style={{ marginBottom: 0 }}>
          <h2>Worth a look</h2>
          <ul className="import-warnings">
            {result.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="muted fine">
        Fonts, colours and spacing are left to LaTeX, so the PDF looks like a LaTeX document rather than a copy of the Word page. The
        conversion ran in this browser; nothing was uploaded.
      </p>
      <div className="actions">
        <button className="btn" onClick={props.onClose}>
          Close
        </button>
        <button className="btn primary" autoFocus onClick={() => props.onOpen(projectId)}>
          Open the project
        </button>
      </div>
    </Dialog>
  );
}

/** A plain-language list of what the import produced, for the dialog. */
function describeSummary(result: ConvertedProject): string[] {
  const { summary } = result;
  const count = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);
  const items: string[] = [];
  const unit = summary.documentClass === 'report' ? ['chapter', 'chapters'] : ['section file', 'section files'];
  if (summary.parts > 0) items.push(count(summary.parts, unit[0]!, unit[1]!));
  if (summary.images > 0) items.push(count(summary.images, 'picture', 'pictures'));
  if (summary.tables > 0) items.push(count(summary.tables, 'table', 'tables'));
  if (summary.equations > 0) items.push(count(summary.equations, 'equation', 'equations'));
  if (summary.lists > 0) items.push(count(summary.lists, 'list', 'lists'));
  if (summary.footnotes > 0) items.push(count(summary.footnotes, 'footnote', 'footnotes'));
  if (summary.references > 0) items.push(count(summary.references, 'reference', 'references'));
  return items;
}
