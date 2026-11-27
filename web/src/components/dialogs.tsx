import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { Strings } from "../state/i18n.js";
import { Icon } from "./primitives.js";

function Dialog({ title, onClose, children }: { title: string; onClose?: () => void; children: ReactNode }) {
  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <header className="dialog__head">
          <h2>{title}</h2>
          {onClose ? (
            <button type="button" className="iconbtn" aria-label="Close" onClick={onClose} autoFocus>
              <Icon name="x" size={14} />
            </button>
          ) : null}
        </header>
        {children}
      </div>
    </div>
  );
}

export function ShortcutsDialog({ t, onClose }: { t: Strings; onClose(): void }) {
  return (
    <Dialog title={t.shortcuts} onClose={onClose}>
      <dl className="shortcuts">
        {t.shortcutList.map(([keys, action]) => (
          <div key={keys}>
            <dt>
              {keys.split(" / ").map((key) => (
                <kbd key={key}>{key}</kbd>
              ))}
            </dt>
            <dd>{action}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}

/** Shown when the server answers 401: it was started with CODER_API_TOKEN. */
export function TokenDialog({ t, onSubmit }: { t: Strings; onSubmit(token: string): void }) {
  const [token, setToken] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (token.trim()) onSubmit(token.trim());
  };
  return (
    <Dialog title={t.tokenTitle}>
      <form className="tokenform" onSubmit={submit}>
        <p>{t.tokenBody}</p>
        <input type="password" autoComplete="off" autoFocus value={token} aria-label={t.tokenTitle} onChange={(event) => setToken(event.target.value)} />
        <button type="submit" className="btn btn--primary" disabled={!token.trim()}>
          {t.tokenAction}
        </button>
      </form>
    </Dialog>
  );
}

const NOTICE_MS = 9000;

/** Something the person asked for did not work. Says why, then gets out of the way. */
export function Notice({ t, message, onDismiss }: { t: Strings; message: string; onDismiss(): void }) {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    const timer = setTimeout(() => dismiss.current(), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [message]);
  return (
    <div className="notice" role="alert">
      <Icon name="alert" size={16} />
      <span>{message}</span>
      <button type="button" className="iconbtn" aria-label={t.close} onClick={onDismiss}>
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}
