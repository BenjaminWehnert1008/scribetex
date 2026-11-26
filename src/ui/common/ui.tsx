import { X } from 'lucide-react';
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { dismissToast, toasts } from '@/app/services';
import { useStore } from '../hooks/useStore';

export function Dialog(props: { title: string; onClose?: () => void; children: ReactNode; wide?: boolean; labelledBy?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const { onClose } = props;
  const onEscape = useEffectEvent(() => onClose?.());
  // The focus moves into the dialog once, when it opens, and back when it closes. It must not move
  // again while the dialog is open: callers pass a new onClose with every render, and a dialog that
  // went back to its first field each time would put what someone is typing into the wrong field.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const focusable = ref.current?.querySelector<HTMLElement>('[autofocus], input, select, textarea, button');
    focusable?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onEscape();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, []);
  return (
    <div
      className="backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && onClose) onClose();
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-label={props.title} ref={ref} style={props.wide ? { width: 'min(720px, 100%)' } : undefined}>
        <h2>{props.title}</h2>
        {props.children}
      </div>
    </div>
  );
}

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  run: () => void;
  disabled?: boolean;
  danger?: boolean;
  separatorBefore?: boolean;
}

export function Menu(props: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: props.x, top: props.y });
  const { onClose } = props;
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    setPosition({
      left: Math.max(4, Math.min(props.x, window.innerWidth - box.width - 4)),
      top: Math.max(4, Math.min(props.y, window.innerHeight - box.height - 4)),
    });
    ref.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
  }, [props.x, props.y]);
  useEffect(() => {
    const close = (event: Event): void => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
      if (event.type === 'mousedown' && ref.current?.contains(event.target as Node)) return;
      onClose();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
      window.removeEventListener('blur', close);
    };
  }, [onClose]);
  return (
    <div className="menu" role="menu" ref={ref} style={position}>
      {props.items.map((item) => (
        <div key={item.label}>
          {item.separatorBefore && <hr />}
          <button
            role="menuitem"
            className={item.danger ? 'danger' : undefined}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.run();
            }}
          >
            {item.icon}
            {item.label}
          </button>
        </div>
      ))}
    </div>
  );
}

export function Toasts() {
  const list = useStore(toasts);
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {list.map((toast) => (
        <div key={toast.id} className={`toast ${toast.kind === 'error' ? 'error' : ''}`}>
          <span style={{ flex: 1 }}>{toast.text}</span>
          {toast.action && (
            <button
              onClick={() => {
                toast.action!.run();
                dismissToast(toast.id);
              }}
            >
              {toast.action.label}
            </button>
          )}
          <button aria-label="Dismiss" onClick={() => dismissToast(toast.id)} style={{ textDecoration: 'none' }}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Hands a file to the browser's download handling. */
export function downloadBytes(name: string, bytes: Uint8Array, type: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function formatAgo(then: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return days === 1 ? 'yesterday' : `${days} days ago`;
  return new Date(then).toLocaleDateString();
}

export function formatDateTime(at: number): string {
  return new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Re-renders the caller every `ms` so relative times stay current. */
export function useTick(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}
