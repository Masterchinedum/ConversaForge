/**
 * Participant session token handling (the `cfs_…` bearer issued when a session is created).
 * Tokens live in sessionStorage + localStorage under `cf:session:<id>` (see ARCHITECTURE.md) so a
 * refresh can resume the call. A `#t=<token>` fragment is accepted once, moved into storage and
 * stripped from the URL so it does not linger in history, screenshots or Referer headers.
 */

const KEY = (sessionId: string) => `cf:session:${sessionId}`;
const TOKEN_RE = /^cfs_[A-Za-z0-9_.~-]{16,512}$/;

function safeGet(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}
function safeSet(storage: () => Storage, key: string, value: string) {
  try {
    storage().setItem(key, value);
  } catch {
    /* storage may be disabled (private mode / partitioned iframe) */
  }
}
function safeRemove(storage: () => Storage, key: string) {
  try {
    storage().removeItem(key);
  } catch {
    /* ignore */
  }
}

export function isPlausibleSessionToken(token: string | null | undefined): token is string {
  return !!token && TOKEN_RE.test(token);
}

export function storeSessionToken(sessionId: string, token: string) {
  safeSet(() => sessionStorage, KEY(sessionId), token);
  safeSet(() => localStorage, KEY(sessionId), token);
}

export function clearSessionToken(sessionId: string) {
  safeRemove(() => sessionStorage, KEY(sessionId));
  safeRemove(() => localStorage, KEY(sessionId));
}

/**
 * Resolve the token for a session: URL fragment (`#t=`) first (then persisted + stripped),
 * otherwise sessionStorage, otherwise localStorage.
 */
export function readSessionToken(sessionId: string): string | null {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash.replace(/^#/, '');
  if (hash) {
    const params = new URLSearchParams(hash);
    const t = params.get('t');
    if (t) {
      params.delete('t');
      const rest = params.toString();
      const url = window.location.pathname + window.location.search + (rest ? `#${rest}` : '');
      window.history.replaceState(window.history.state, '', url);
      if (isPlausibleSessionToken(t)) {
        storeSessionToken(sessionId, t);
        return t;
      }
    }
  }
  const fromSession = safeGet(() => sessionStorage, KEY(sessionId));
  if (fromSession) return fromSession;
  const fromLocal = safeGet(() => localStorage, KEY(sessionId));
  if (fromLocal) {
    // Keep the per-tab copy in sync for subsequent reads.
    safeSet(() => sessionStorage, KEY(sessionId), fromLocal);
    return fromLocal;
  }
  return null;
}

/**
 * Validate a `?return=` target: only same-origin relative paths ("/course/x"), never
 * protocol-relative ("//evil.com"), backslash tricks, or absolute URLs.
 */
export function safeReturnUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return null;
  if (/[\u0000-\u001f\\]/.test(value)) return null;
  if (value.length > 2000) return null;
  try {
    const base = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
    const u = new URL(value, base);
    if (u.origin !== base) return null;
    return u.pathname + u.search + u.hash;
  } catch {
    return null;
  }
}

/** Stable per-tab id so the server can tell a reconnect of this tab from a second tab. */
export function clientInstanceId(): string {
  const k = 'cf:client-instance';
  let id = safeGet(() => sessionStorage, k);
  if (!id) {
    id = randomId();
    safeSet(() => sessionStorage, k, id);
  }
  return id;
}

export function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
