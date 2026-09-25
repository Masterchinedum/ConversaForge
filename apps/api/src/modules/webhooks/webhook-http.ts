import http from 'node:http';
import https from 'node:https';
import { SsrfError, safeLookup } from './ssrf-guard';

export interface SendResult {
  statusCode: number | null;
  error: string | null;
  responseSnippet: string | null;
  durationMs: number;
}

const MAX_SNIPPET = 1024;

/**
 * POST a JSON body with SSRF-safe DNS resolution, no redirects and a hard timeout.
 * Never throws: network errors are returned as `error`.
 */
export function postJson(
  url: URL,
  body: string,
  headers: Record<string, string>,
  opts: { timeoutMs: number; allowLoopback: boolean },
): Promise<SendResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: Omit<SendResult, 'durationMs'>) => {
      if (settled) return;
      settled = true;
      resolve({ ...r, durationMs: Date.now() - started });
    };
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      url,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Length': String(Buffer.byteLength(body)) },
        lookup: safeLookup(opts.allowLoopback) as any,
        timeout: opts.timeoutMs,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          if (size < MAX_SNIPPET) chunks.push(c);
          size += c.length;
        });
        res.on('end', () =>
          done({
            statusCode: res.statusCode ?? null,
            error: null,
            responseSnippet: Buffer.concat(chunks).toString('utf8').slice(0, MAX_SNIPPET) || null,
          }),
        );
        res.on('error', (e) => done({ statusCode: res.statusCode ?? null, error: e.message, responseSnippet: null }));
      },
    );
    // Overall deadline (connect + response), in addition to the socket idle timeout.
    const timer = setTimeout(() => {
      req.destroy(new Error(`Timed out after ${opts.timeoutMs} ms`));
    }, opts.timeoutMs);
    req.on('timeout', () => req.destroy(new Error(`Timed out after ${opts.timeoutMs} ms`)));
    req.on('error', (e: any) => {
      clearTimeout(timer);
      const msg = e instanceof SsrfError ? e.message : e?.code ? `${e.code}: ${e.message}` : String(e?.message ?? e);
      done({ statusCode: null, error: msg.slice(0, 500), responseSnippet: null });
    });
    req.on('close', () => clearTimeout(timer));
    req.end(body);
  });
}
