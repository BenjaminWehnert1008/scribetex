import { Download, ZoomIn, ZoomOut } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { reportError } from '@/app/services';
import { downloadBytes } from '../common/ui';
import { PdfSurface, type SurfaceInfo } from './pdf-surface';

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
}

export function PdfView(props: PdfViewProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const surface = useRef<PdfSurface | null>(null);
  const [info, setInfo] = useState<SurfaceInfo>({ pages: 0, scale: 1, zoom: 'fit' });
  const { pdf, version } = props;

  useEffect(() => {
    if (!scroller.current || !host.current) return;
    const created = new PdfSurface(scroller.current, host.current, setInfo);
    surface.current = created;
    return () => {
      created.dispose();
      surface.current = null;
    };
  }, []);

  useEffect(() => {
    const current = surface.current;
    if (!current) return;
    if (!pdf) {
      current.clear();
      return;
    }
    current.show(pdf).catch((error: unknown) => reportError(error, 'The PDF could not be displayed'));
  }, [pdf, version]);

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
      <div className="pdf-scroll" ref={scroller} tabIndex={0} aria-label="PDF preview">
        {!pdf && <div className="pdf-empty">{props.empty}</div>}
        <div ref={host} />
      </div>
    </>
  );
}
