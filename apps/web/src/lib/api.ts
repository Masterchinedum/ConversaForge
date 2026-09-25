/**
 * Browser/server fetch helper for the ConversaForge API. All calls go through the Next.js
 * same-origin proxy (/api/* → API server), so the httpOnly session cookie is sent automatically.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown> | unknown[] | null;

export interface ApiOptions extends Omit<RequestInit, 'body'> {
  body?: Json | FormData | Blob;
  /** Bearer token for participant/session-scoped calls (never a user secret). */
  token?: string;
  query?: Record<string, string | number | boolean | undefined | null>;
}

function buildUrl(path: string, query?: ApiOptions['query']) {
  const base = path.startsWith('/api') ? path : `/api${path.startsWith('/') ? '' : '/'}${path}`;
  if (!query) return base;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const s = qs.toString();
  return s ? `${base}?${s}` : base;
}

export async function api<T = any>(path: string, opts: ApiOptions = {}): Promise<T> {
  const { body, token, query, headers, ...rest } = opts;
  const h = new Headers(headers);
  let payload: BodyInit | undefined;
  if (body instanceof FormData || body instanceof Blob) payload = body;
  else if (body !== undefined) {
    h.set('Content-Type', 'application/json');
    payload = JSON.stringify(body);
  }
  if (token) h.set('Authorization', `Bearer ${token}`);
  const res = await fetch(buildUrl(path, query), { credentials: 'include', ...rest, headers: h, body: payload });
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  const data = ct.includes('application/json') ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) {
    const err = (data as any)?.error;
    throw new ApiError(res.status, err?.code ?? 'error', err?.message ?? `Request failed (${res.status})`, err?.details);
  }
  return data as T;
}

/** SWR fetcher: key is the API path (string) or [path, query]. */
export const fetcher = (key: string | [string, ApiOptions['query']]) =>
  Array.isArray(key) ? api(key[0], { query: key[1] }) : api(key);

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (Array.isArray(e.details) && e.details.length && (e.details[0] as any)?.message) {
      return `${e.message}: ${(e.details as any[]).map((d) => `${d.path ? d.path + ': ' : ''}${d.message}`).join('; ')}`;
    }
    return e.message;
  }
  return e instanceof Error ? e.message : 'Something went wrong';
}

/** Trigger a browser download for an authenticated API endpoint (CSV/PDF exports). */
export async function download(path: string, fallbackName: string, query?: ApiOptions['query']) {
  const res = await fetch(buildUrl(path, query), { credentials: 'include' });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? 'Download failed');
  }
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') ?? '';
  const name = /filename="?([^";]+)"?/.exec(cd)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function wsUrl(path: string) {
  const base =
    process.env.NEXT_PUBLIC_API_WS_URL ||
    (typeof window !== 'undefined' ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}` : '');
  return `${base}${path}`;
}
