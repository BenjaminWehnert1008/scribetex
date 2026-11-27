import { Download, LocateFixed, ZoomIn, ZoomOut } from 'lucide-react';
import { type MouseEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { reportError } from '@/app/services';
import { downloadBytes } from '../common/ui';
import { PreviewTrouble } from './BrowserAdvice';
import { PdfSurface, type PagePoint, type PageRect, type SurfaceInfo } from './pdf-surface';

export interface PdfViewProps {
  pdf: Uint8Array | null;
  /** Changes whenever `pdf` was replaced. */
  version: number;
  /** True when the newest compile failed and this is an older PDF. */
  stale: boolean;
  running: boolean;
  fileName: string;
  /** Shown instead of pages while there is no PDF yet. */
  empty: ReactNode;
  /** Double-click or Ctrl+click on a page: find the source of that point. Absent when the PDF has no SyncTeX data. */
  onFindSource?: (point: PagePoint, word: string | null) => void;
  /** Shows where the editor's cursor is in the PDF. Absent when that is not possible. */
  onShowCursor?: () => void;
  /** A place to scroll to and mark; a new object each time, also for the same place. */
  reveal?: { page: number; rects: PageRect[] } | null;
}

export function PdfView(props: PdfViewProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const surface = useRef<PdfSurface | null>(null);
  const [info, setInfo] = useState<SurfaceInfo>({ pages: 0, scale: 1, zoom: 'fit' });
  /** A page of the current PDF could not be drawn, or the PDF could not be opened. */
  const [trouble, setTrouble] = useState(false);
  const { pdf, version } = props;

  useEffect(() => {
    if (!scroller.current || !host.current) return;
    const created = new PdfSurface(scroller.current, host.current, setInfo, (error) => {
      console.warn('A page of the PDF could not be drawn:', error);
      setTrouble(true);
    });
    surface.current = created;
    return () => {
      created.dispose();
      surface.current = null;
    };
  }, []);

  useEffect(() => {
    const current = surface.current;
    if (!current) return;
    setTrouble(false);
    if (!pdf) {
      current.clear();
      return;
    }
    current.show(pdf).catch((error: unknown) => {
      setTrouble(true);
      reportError(error, 'The PDF could not be displayed');
    });
  }, [pdf, version]);

  const { reveal } = props;
  useEffect(() => {
    if (reveal) surface.current?.reveal(reveal.page, reveal.rects);
  }, [reveal]);

  const findSource = props.onFindSource;
  const onPagePointer = (event: MouseEvent<HTMLDivElement>, how: 'double' | 'single'): void => {
    if (!findSource || !surface.current) return;
    if (how === 'single' && !(event.ctrlKey || event.metaKey)) return;
    const point = surface.current.pointAt(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    // A double-click also selects page text in some browsers; that selection means nothing here.
    window.getSelection()?.removeAllRanges();
    const current = surface.current;
    void current.wordAt(point).then((word) => findSource(point, word));
  };

  return (
    <>
      <div className="pdf-bar">
        <button className="icon-btn" title="Zoom out" aria-label="Zoom out" disabled={!pdf} onClick={() => surface.current?.step(-1)}>
          <ZoomOut size={16} />
        </button>
        <button
          className="btn quiet small"
          title={info.zoom === 'fit' ? 'The page fills the width of this pane' : 'Fit the page to the width of this pane'}
          disabled={!pdf}
          onClick={() => surface.current?.setZoom('fit')}
        >
          {pdf ? `${Math.round(info.scale * 100)} %${info.zoom === 'fit' ? ', fit' : ''}` : 'Preview'}
        </button>
        <button className="icon-btn" title="Zoom in" aria-label="Zoom in" disabled={!pdf} onClick={() => surface.current?.step(1)}>
          <ZoomIn size={16} />
        </button>
        <span className="grow" />
        {props.onShowCursor && (
          <button className="icon-btn" title="Show the cursor position in the PDF. Double-click the PDF to go back to the source." aria-label="Show the cursor position in the PDF" disabled={!pdf} onClick={props.onShowCursor}>
            <LocateFixed size={16} />
          </button>
        )}
        {pdf && <span>{info.pages === 1 ? '1 page' : `${info.pages} pages`}</span>}
        <button
          className="icon-btn"
          title="Download the PDF"
          aria-label="Download the PDF"
          disabled={!pdf}
          onClick={() => pdf && downloadBytes(props.fileName, pdf, 'application/pdf')}
        >
          <Download size={16} />
        </button>
      </div>
      <div className={`progress ${props.running ? 'on' : ''}`} />
      {props.stale && pdf && <div className="pdf-stale">Showing the last version that compiled</div>}
      <div
        className="pdf-scroll"
        ref={scroller}
        tabIndex={0}
        aria-label="PDF preview"
        onDoubleClick={(event) => onPagePointer(event, 'double')}
        onClick={(event) => onPagePointer(event, 'single')}
      >
        {!pdf && <div className="pdf-empty">{props.empty}</div>}
        {pdf && trouble && <PreviewTrouble />}
        <div ref={host} />
      </div>
    </>
  );
}
