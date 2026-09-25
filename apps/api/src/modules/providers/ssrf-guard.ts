import { promises as dns } from 'node:dns';
import * as https from 'node:https';
import { BlockList, isIP } from 'node:net';

/**
 * Outbound HTTP for user-configured endpoints (custom functions). Protections:
 *  - https only, no credentials in the URL
 *  - host must be in the function's allowedHosts (exact, or "*.example.com" suffix wildcard)
 *  - DNS is resolved up front and EVERY address must be public (no private, loopback, link-local,
 *    CGNAT, multicast, reserved, cloud metadata, IPv4-mapped/NAT64/6to4 wrappers of those);
 *    the connection is pinned to the vetted address (defeats DNS rebinding), SNI/Host stay the hostname
 *  - redirects are never followed (3xx → error)
 *  - response body capped (default 64 KB), overall timeout
 */

export class SsrfError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'invalid_url'
      | 'protocol'
      | 'host_not_allowed'
      | 'blocked_ip'
      | 'dns'
      | 'redirect'
      | 'too_large'
      | 'timeout'
      | 'network' = 'network',
  ) {
    super(message);
  }
}

const v4 = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  v4.addSubnet(net, prefix, 'ipv4');
}
v4.addAddress('255.255.255.255', 'ipv4');

const v6 = new BlockList();
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::', 96], // IPv4-compatible (deprecated)
  ['100::', 64], // discard
  ['2001::', 23], // IETF protocol assignments (incl. Teredo 2001::/32)
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
] as const) {
  v6.addSubnet(net, prefix, 'ipv6');
}

function expandIpv6(ip: string): number[] | null {
  // Returns 8 16-bit groups; handles embedded dotted IPv4 tail.
  let s = ip.toLowerCase().split('%')[0]!;
  const v4tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4tail) {
    const parts = v4tail[1]!.split('.').map(Number);
    s = s.slice(0, -v4tail[1]!.length) + ((parts[0]! << 8) | parts[1]!).toString(16) + ':' + ((parts[2]! << 8) | parts[3]!).toString(16);
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const fill = s.includes('::') ? 8 - h.length - t.length : 0;
  const groups = [...h, ...Array(fill).fill('0'), ...t].map((g) => parseInt(g || '0', 16));
  return groups.length === 8 && groups.every((g) => Number.isFinite(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function v4FromGroups(a: number, b: number): string {
  return `${a >> 8}.${a & 0xff}.${b >> 8}.${b & 0xff}`;
}

/** True when the address must never be contacted from the server. */
export function isBlockedIp(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return v4.check(ip, 'ipv4');
  if (fam !== 6) return true;
  const g = expandIpv6(ip);
  if (!g) return true;
  // IPv4-mapped ::ffff:a.b.c.d
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isBlockedIp(v4FromGroups(g[6]!, g[7]!));
  // NAT64 64:ff9b::/96
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isBlockedIp(v4FromGroups(g[6]!, g[7]!));
  // 6to4 2002:AABB:CCDD::/48
  if (g[0] === 0x2002) return isBlockedIp(v4FromGroups(g[1]!, g[2]!));
  return v6.check(ip.split('%')[0]!, 'ipv6');
}

export function normalizeHost(h: string): string {
  return h.trim().toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
}

export function hostAllowed(host: string, allowedHosts: string[]): boolean {
  const h = normalizeHost(host);
  return allowedHosts.some((raw) => {
    const a = normalizeHost(raw);
    if (!a) return false;
    if (a.startsWith('*.')) {
      const suffix = a.slice(1); // ".example.com"
      return h.endsWith(suffix) && h.length > suffix.length;
    }
    return h === a;
  });
}

const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** Validate a function URL at configuration time (no DNS). Returns the parsed URL. */
export function validateOutboundUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SsrfError('The URL is not valid', 'invalid_url');
  }
  if (u.protocol !== 'https:') throw new SsrfError('Only https:// URLs are allowed', 'protocol');
  if (u.username || u.password) throw new SsrfError('Credentials in the URL are not allowed; use headers instead', 'invalid_url');
  const host = normalizeHost(u.hostname);
  if (isIP(host)) {
    if (isBlockedIp(host)) throw new SsrfError('Private, loopback and reserved IP addresses are not allowed', 'blocked_ip');
  } else if (!HOSTNAME_RE.test(host) || /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/.test(host)) {
    throw new SsrfError('The host name is not allowed (use a public DNS name)', 'host_not_allowed');
  }
  return u;
}

export interface GuardedRequest {
  url: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  allowedHosts: string[];
  timeoutMs: number;
  maxResponseBytes?: number;
}

export interface GuardedResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  address: string;
}

export interface GuardDeps {
  lookup: (host: string) => Promise<Array<{ address: string; family: number }>>;
  isBlockedIp: (ip: string) => boolean;
  /** Extra TLS options (tests use a private CA). */
  tls?: https.RequestOptions;
}

export const defaultGuardDeps: GuardDeps = {
  lookup: (host) => dns.lookup(host, { all: true, verbatim: true }),
  isBlockedIp,
};

export async function guardedRequest(req: GuardedRequest, deps: GuardDeps = defaultGuardDeps): Promise<GuardedResponse> {
  const u = validateOutboundUrl(req.url);
  const host = normalizeHost(u.hostname);
  if (!hostAllowed(host, req.allowedHosts)) throw new SsrfError(`Host "${host}" is not in the allowed hosts list`, 'host_not_allowed');
  const maxBytes = req.maxResponseBytes ?? 64 * 1024;
  const deadline = Date.now() + req.timeoutMs;

  let address: string;
  let family: number;
  if (isIP(host)) {
    address = host;
    family = isIP(host);
  } else {
    let addrs: Array<{ address: string; family: number }>;
    try {
      addrs = await withDeadline(deps.lookup(host), deadline, 'DNS lookup');
    } catch (e) {
      if (e instanceof SsrfError) throw e;
      throw new SsrfError(`Could not resolve "${host}"`, 'dns');
    }
    if (!addrs.length) throw new SsrfError(`Could not resolve "${host}"`, 'dns');
    const blocked = addrs.find((a) => deps.isBlockedIp(a.address));
    if (blocked) throw new SsrfError(`"${host}" resolves to a private or reserved address, which is not allowed`, 'blocked_ip');
    address = addrs[0]!.address;
    family = addrs[0]!.family;
  }
  if (deps.isBlockedIp(address)) throw new SsrfError('The destination address is not allowed', 'blocked_ip');

  const remaining = Math.max(1, deadline - Date.now());
  return new Promise<GuardedResponse>((resolve, reject) => {
    const r = https.request(
      {
        protocol: 'https:',
        hostname: host,
        port: u.port ? Number(u.port) : 443,
        path: `${u.pathname}${u.search}`,
        method: req.method,
        headers: { ...(req.headers ?? {}), host: u.host },
        servername: isIP(host) ? undefined : host,
        // Pin the connection to the vetted address (no second DNS lookup → no rebinding).
        lookup: ((_h: string, opts: any, cb: any) => {
          if (opts?.all) cb(null, [{ address, family }]);
          else cb(null, address, family);
        }) as any,
        agent: false,
        timeout: remaining,
        ...(deps.tls ?? {}),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          r.destroy();
          reject(new SsrfError(`The endpoint responded with a redirect (${status}); redirects are not followed`, 'redirect'));
          return;
        }
        const declared = Number(res.headers['content-length'] ?? 0);
        if (declared > maxBytes) {
          r.destroy();
          reject(new SsrfError(`The response is larger than ${Math.round(maxBytes / 1024)} KB`, 'too_large'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            r.destroy();
            reject(new SsrfError(`The response is larger than ${Math.round(maxBytes / 1024)} KB`, 'too_large'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks), address }));
        res.on('error', (e) => reject(new SsrfError(`Network error: ${e.message}`, 'network')));
      },
    );
    const timer = setTimeout(() => {
      r.destroy();
      reject(new SsrfError(`The endpoint did not respond within ${req.timeoutMs} ms`, 'timeout'));
    }, remaining);
    r.on('timeout', () => {
      r.destroy();
      reject(new SsrfError(`The endpoint did not respond within ${req.timeoutMs} ms`, 'timeout'));
    });
    r.on('error', (e: any) => reject(e instanceof SsrfError ? e : new SsrfError(`Network error: ${e?.code ?? e?.message ?? 'request failed'}`, 'network')));
    r.on('close', () => clearTimeout(timer));
    if (req.body !== undefined && req.method !== 'GET') r.write(req.body);
    r.end();
  });
}

async function withDeadline<T>(p: Promise<T>, deadline: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, rej) => {
        t = setTimeout(() => rej(new SsrfError(`${what} timed out`, 'timeout')), Math.max(1, deadline - Date.now()));
      }),
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
}
