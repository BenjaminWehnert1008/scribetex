/**
 * What the app says in a browser that is a few updates behind (see pdfjs.ts):
 * a calm tip above an open project, shown until it is dismissed, and a note in
 * the preview when a page could not be drawn at all.
 */
import { Info, X } from 'lucide-react';
import { useState } from 'react';
import { APP_NAME } from '@/app/brand';
import { detectBrowser } from '@/app/services';
import { CHROME_URL, EDGE_URL } from '../home/notices';
import { browserIsBehind } from './pdfjs';

const DISMISSED_KEY = 'latex-editor:browser-tip-dismissed';

function tipDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function dismissTip(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, '1');
  } catch {
    // Without storage the tip simply shows again next time.
  }
}

/** "Safari" or "Firefox", which are updated on their own; null for any other browser. */
function browserName(): string | null {
  const browser = detectBrowser();
  return browser.safari ? 'Safari' : browser.firefox ? 'Firefox' : null;
}

/** "update Safari or open scribeTeX in Chrome or Edge", for this browser. */
function remedy(name: string | null): string {
  return `update ${name ?? 'this browser'} or open ${APP_NAME} in Chrome or Edge`;
}

function GetLinks() {
  return (
    <>
      <a href={CHROME_URL} target="_blank" rel="noopener noreferrer">
        Get Chrome
      </a>{' '}
      ·{' '}
      <a href={EDGE_URL} target="_blank" rel="noopener noreferrer">
        Get Edge
      </a>
    </>
  );
}

/** A banner above the project. Shows nothing in an up-to-date browser, or once dismissed. */
export function BrowserTip() {
  const [shown, setShown] = useState(() => browserIsBehind() && !tipDismissed());
  if (!shown) return null;
  const name = browserName();
  return (
    <div className="banner info" role="status">
      <Info size={16} />
      <span className="grow">
        Tip: {name ? `this version of ${name}` : 'this browser'} is a few updates behind, so the preview runs in a compatibility mode. For more
        speed and the best quality, {remedy(name)}. <GetLinks />
      </span>
      <button
        className="icon-btn"
        aria-label="Dismiss the tip"
        onClick={() => {
          dismissTip();
          setShown(false);
        }}
      >
        <X size={15} />
      </button>
    </div>
  );
}

/** Shown in the preview when a page of the PDF could not be drawn. */
export function PreviewTrouble() {
  const behind = browserIsBehind();
  return (
    <div className="pdf-trouble" role="status">
      <b>The preview could not draw this PDF.</b> You can still download it with the button above.
      {behind && (
        <>
          {' '}
          This browser is a few updates behind. To see the PDF here, {remedy(browserName())}. <GetLinks />
        </>
      )}
    </div>
  );
}
