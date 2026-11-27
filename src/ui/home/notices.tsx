/**
 * The wording that tells people where their work is kept. The same sentences
 * are used on the first visit, on the home screen and in the help dialog, so
 * they are written once here.
 */
import type { BrowserAbilities } from '@/app/services';
import { APP_NAME } from '@/app/brand';
import { Dialog } from '../common/ui';

export const CHROME_URL = 'https://www.google.com/chrome/';
export const EDGE_URL = 'https://www.microsoft.com/edge/download';

const ACK_KEY = 'latex-editor:storage-notice-seen';

export function noticeSeen(): boolean {
  try {
    return localStorage.getItem(ACK_KEY) === '1';
  } catch {
    return false;
  }
}

export function markNoticeSeen(): void {
  try {
    localStorage.setItem(ACK_KEY, '1');
  } catch {
    // Without storage the notice simply shows again next time.
  }
}

export function StorageNoticeText(props: { browser: BrowserAbilities; onGuide?: () => void }) {
  if (props.browser.folderAccess) {
    return (
      <>
        <h2>Your work stays on this computer.</h2>
        <p>
          Projects are saved inside this browser, on this device. Nothing is uploaded, and nothing is backed up to a cloud unless you connect one
          yourself. If you clear this browser's site data or lose this computer, the projects are gone. To be safe, link each project to a folder
          on your disk. You can also connect a private GitHub repository, or download a ZIP at any time.
        </p>
      </>
    );
  }
  return (
    <>
      <h2>Tip: for saving to a folder, open {APP_NAME} in Chrome or Edge.</h2>
      <p>
        You can write here as usual, and every change is saved in this browser. To make sure a project can never be lost, choose one of two
        equally safe ways:
      </p>
      <ul className="notice-options">
        <li>
          <b>Switch to Chrome or Edge on a computer.</b> There, each project can also be saved as ordinary files in a folder on your disk.{' '}
          <a href={CHROME_URL} target="_blank" rel="noopener noreferrer">
            Get Chrome
          </a>{' '}
          ·{' '}
          <a href={EDGE_URL} target="_blank" rel="noopener noreferrer">
            Get Edge
          </a>
        </li>
        <li>
          <b>Or stay here and connect a free, private GitHub repository.</b> Once connected, each project is backed up there by itself, so nothing
          is lost even if this browser's data is cleared.
          {props.onGuide && (
            <div style={{ marginTop: 8 }}>
              <button type="button" className="btn small primary" onClick={props.onGuide}>
                Show me how, step by step
              </button>
            </div>
          )}
        </li>
      </ul>
      {props.browser.safari && (
        <p className="muted" style={{ marginTop: 8 }}>
          Good to know: Safari clears a site's data when the site has not been opened for seven days, so one of the two ways is worth it here.
        </p>
      )}
    </>
  );
}

export function StorageNoticeDialog(props: { browser: BrowserAbilities; onClose: () => void; onGuide?: () => void }) {
  return (
    <Dialog title="Where your work is saved" onClose={props.onClose}>
      <div className="notice-card" style={{ margin: '4px 0 0' }}>
        <StorageNoticeText browser={props.browser} onGuide={props.onGuide} />
      </div>
      <ul className="muted" style={{ margin: '14px 0 0', paddingLeft: 18, display: 'grid', gap: 6, fontSize: 13.5 }}>
        <li>Every change is saved within a second or two. There is no save button to forget.</li>
        <li>A version of each project is kept every 10 minutes, so you can go back.</li>
        <li>The save status at the top of a project always says where the work currently is.</li>
        <li>LaTeX is compiled inside this browser. Your documents are not sent to a server.</li>
      </ul>
      <div className="actions">
        <button className="btn primary" data-autofocus onClick={props.onClose}>
          I understand
        </button>
      </div>
    </Dialog>
  );
}
