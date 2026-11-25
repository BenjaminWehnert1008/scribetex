/**
 * The wording that tells people where their work is kept. The same sentences
 * are used on the first visit, on the home screen and in the help dialog, so
 * they are written once here.
 */
import type { BrowserAbilities } from '@/app/services';
import { Dialog } from '../common/ui';

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

export function StorageNoticeText(props: { browser: BrowserAbilities }) {
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
      <h2>This browser cannot save to a folder.</h2>
      <p>
        You can work here, but your projects exist only inside this browser. Download a ZIP when you finish a session, or connect a GitHub backup.
        For saving to a folder, open this site in Chrome or Edge on a computer.
      </p>
      {props.browser.safari && (
        <p style={{ marginTop: 8 }}>
          Safari may delete a site's data when the site has not been opened for seven days. Please keep a ZIP or a GitHub backup of anything
          you care about.
        </p>
      )}
    </>
  );
}

export function StorageNoticeDialog(props: { browser: BrowserAbilities; onClose: () => void }) {
  return (
    <Dialog title="Where your work is saved" onClose={props.onClose}>
      <div className={`notice-card ${props.browser.folderAccess ? '' : 'warn'}`} style={{ margin: '4px 0 0' }}>
        <StorageNoticeText browser={props.browser} />
      </div>
      <ul className="muted" style={{ margin: '14px 0 0', paddingLeft: 18, display: 'grid', gap: 6, fontSize: 13.5 }}>
        <li>Every change is saved within a second or two. There is no save button to forget.</li>
        <li>A version of each project is kept every 10 minutes, so you can go back.</li>
        <li>The save status at the top of a project always says where the work currently is.</li>
        <li>LaTeX is compiled inside this browser. Your documents are not sent to a server.</li>
      </ul>
      <div className="actions">
        <button className="btn primary" onClick={props.onClose}>
          I understand
        </button>
      </div>
    </Dialog>
  );
}
