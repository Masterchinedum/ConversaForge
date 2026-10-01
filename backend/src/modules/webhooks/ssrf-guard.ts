import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';

/**
 * SSRF protection for outbound requests to customer-supplied URLs (webhooks).
 *
 * - Only https:// (http://localhost / 127.0.0.1 / [::1] is allowed when NODE_ENV=development).
 * - No credentials in the URL, no internal-looking hostnames.
 * - Every resolved address must be public: private, loopback, link-local (incl. cloud metadata
 *   169.254.169.254 / fd00:ec2::254), CGNAT, multicast, reserved and documentation ranges are blocked.
 * - At delivery time the same check runs inside the socket's DNS lookup (`safeLookup`), so the address
 *   actually connected to is the one that was validated (defeats DNS rebinding).
 */
export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

export interface UrlPolicy {
  /** true when NODE_ENV=development: permits http://localhost for local receivers. */
  allowDevLocalhost: boolean;
}

const LOCALHOST_NAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const BLOCKED_HOST_SUFFIXES = ['.internal', '.local', '.localhost', '.localdomain', '.home.arpa', '.intranet', '.corp'];
const BLOCKED_HOSTS = new Set(['metadata', 'metadata.google.internal', 'instance-data', 'kubernetes.default']);

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

const V4_BLOCKS: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local incl. cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

export function isPrivateIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return V4_BLOCKS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (ipv4ToInt(base) & mask);
  });
}

/** Expand an IPv6 address into 8 hextets (handles "::" and embedded IPv4). */
function expandIPv6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  // Embedded dotted IPv4 at the end.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (isIP(tail) !== 4) return null;
    const n = ipv4ToInt(tail);
    s = `${s.slice(0, lastColon + 1)}${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const pieces = s.split('::');
  if (pieces.length > 2) return null;
  const h = pieces[0] ? pieces[0].split(':') : [];
  const r = pieces.length === 2 ? (pieces[1] ? pieces[1].split(':') : []) : null;
  let parts: string[];
  if (r === null) parts = h;
  else {
    const fill = 8 - h.length - r.length;
    if (fill < 0) return null;
    parts = [...h, ...Array(fill).fill('0'), ...r];
  }
  if (parts.length !== 8 || parts.some((p) => !/^[0-9a-f]{1,4}$/.test(p))) return null;
  return parts.map((p) => parseInt(p, 16));
}

export function isPrivateIPv6(ip: string): boolean {
  const h = expandIPv6(ip);
  if (!h) return true; // unparseable → treat as unsafe
  const allZero = h.every((x) => x === 0);
  if (allZero) return true; // ::
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true; // ::1
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d
  if (h.slice(0, 5).every((x) => x === 0) && (h[5] === 0xffff || h[5] === 0)) {
    const v4 = `${h[6]! >>> 8}.${h[6]! & 0xff}.${h[7]! >>> 8}.${h[7]! & 0xff}`;
    return isPrivateIPv4(v4);
  }
  // NAT64 64:ff9b::/96
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) {
    const v4 = `${h[6]! >>> 8}.${h[6]! & 0xff}.${h[7]! >>> 8}.${h[7]! & 0xff}`;
    return isPrivateIPv4(v4);
  }
  const first = h[0]!;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local (incl. fd00:ec2::254)
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((first & 0xff00) === 0xff00) return true; // multicast
  if (first === 0x2001 && h[1] === 0x0db8) return true; // documentation
  if (first === 0x0100 && h[1] === 0 && h[2] === 0 && h[3] === 0) return true; // discard 100::/64
  if (first === 0x2002) {
    // 6to4 embeds an IPv4 address
    const v4 = `${h[1]! >>> 8}.${h[1]! & 0xff}.${h[2]! >>> 8}.${h[2]! & 0xff}`;
    return isPrivateIPv4(v4);
  }
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isPrivateIPv4(ip);
  if (v === 6) return isPrivateIPv6(ip);
  return true;
}

function isLoopback(ip: string): boolean {
  return (isIP(ip) === 4 && ip.startsWith('127.')) || ip === '::1';
}

function stripBrackets(host: string) {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

export function isDevLocalhost(url: URL, policy: UrlPolicy): boolean {
  return policy.allowDevLocalhost && LOCALHOST_NAMES.has(url.hostname.toLowerCase());
}

/** Static URL checks (no DNS). Throws SsrfError with a user-facing message. */
export function assertUrlShape(raw: string, policy: UrlPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError('Invalid URL');
  }
  if (raw.length > 2000) throw new SsrfError('URL is too long');
  if (url.username || url.password) throw new SsrfError('URLs with embedded credentials are not allowed');
  const devLocal = isDevLocalhost(url, policy);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && devLocal)) {
    throw new SsrfError(
      policy.allowDevLocalhost
        ? 'Webhook URLs must use https:// (http:// is only allowed for localhost in development)'
        : 'Webhook URLs must use https://',
    );
  }
  if (devLocal) return url;
  const host = stripBrackets(url.hostname.toLowerCase());
  if (!host) throw new SsrfError('URL has no host');
  if (LOCALHOST_NAMES.has(host) || host === 'localhost' || BLOCKED_HOSTS.has(host) || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new SsrfError('Webhook URLs must point to a public host');
  }
  if (isIP(host) && isPrivateAddress(host)) throw new SsrfError('Webhook URLs must not point to private, loopback or link-local addresses');
  if (!isIP(host) && !host.includes('.')) throw new SsrfError('Webhook URLs must use a fully-qualified public hostname');
  return url;
}

export type Resolver = (host: string) => Promise<Array<{ address: string; family: number }>>;

export const defaultResolver: Resolver = (host) =>
  new Promise((resolve, reject) =>
    dnsLookup(host, { all: true, verbatim: true }, (err, addrs) => (err ? reject(err) : resolve(addrs as LookupAddress[]))),
  );

/** Full check: URL shape + DNS resolution; every resolved address must be public. */
export async function assertSafeUrl(raw: string, policy: UrlPolicy, resolve: Resolver = defaultResolver): Promise<URL> {
  const url = assertUrlShape(raw, policy);
  if (isDevLocalhost(url, policy)) return url;
  const host = stripBrackets(url.hostname);
  if (isIP(host)) return url; // already checked
  let addrs: Array<{ address: string }>;
  try {
    addrs = await resolve(host);
  } catch {
    throw new SsrfError(`Could not resolve host ${host}`);
  }
  if (!addrs.length) throw new SsrfError(`Could not resolve host ${host}`);
  const bad = addrs.find((a) => isPrivateAddress(a.address));
  if (bad) throw new SsrfError(`Host ${host} resolves to a non-public address`);
  return url;
}

/**
 * A `lookup` function for http(s).request that refuses to connect to non-public addresses
 * (loopback allowed only when `allowLoopback`, i.e. dev localhost receivers).
 */
export function safeLookup(allowLoopback: boolean) {
  return (hostname: string, options: any, callback: any) => {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'function' ? {} : options ?? {};
    dnsLookup(hostname, { ...opts, all: true }, (err, addresses: LookupAddress[]) => {
      if (err) return cb(err);
      const list = Array.isArray(addresses) ? addresses : [];
      const ok = list.filter((a) => !isPrivateAddress(a.address) || (allowLoopback && isLoopback(a.address)));
      if (!ok.length || ok.length !== list.length) {
        return cb(new SsrfError(`Refusing to connect to non-public address for ${hostname}`));
      }
      if (opts.all) return cb(null, ok);
      return cb(null, ok[0]!.address, ok[0]!.family);
    });
  };
}
