import type { IncomingMessage } from 'node:http';
import { BlockList, isIP } from 'node:net';
import { env } from '../../config/env';

/**
 * Client IP for raw (non-Fastify) requests such as WebSocket upgrades, honouring X-Forwarded-For only
 * when the socket peer is a trusted proxy — the same TRUST_PROXY setting Fastify uses for `req.ip`.
 * Without this, any client can send `X-Forwarded-For: <random>` to evade per-IP rate limits.
 */
const NAMED: Record<string, Array<[string, number, 'ipv4' | 'ipv6']>> = {
  loopback: [['127.0.0.0', 8, 'ipv4'], ['::1', 128, 'ipv6']],
  linklocal: [['169.254.0.0', 16, 'ipv4'], ['fe80::', 10, 'ipv6']],
  uniquelocal: [['10.0.0.0', 8, 'ipv4'], ['172.16.0.0', 12, 'ipv4'], ['192.168.0.0', 16, 'ipv4'], ['fc00::', 7, 'ipv6']],
};

let cached: { raw: string; list: BlockList; all: boolean } | null = null;

function trustList() {
  const raw = String(env.TRUST_PROXY ?? '');
  if (cached?.raw === raw) return cached;
  const list = new BlockList();
  let all = false;
  for (const tok of raw.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)) {
    if (tok === 'true' || tok === '*') all = true;
    else if (NAMED[tok]) for (const [net, bits, fam] of NAMED[tok]!) list.addSubnet(net, bits, fam);
    else {
      const [addr, bits] = tok.split('/');
      const fam = isIP(addr ?? '');
      if (!fam) continue;
      if (bits) list.addSubnet(addr!, Number(bits), fam === 4 ? 'ipv4' : 'ipv6');
      else list.addAddress(addr!, fam === 4 ? 'ipv4' : 'ipv6');
    }
  }
  cached = { raw, list, all };
  return cached;
}

function normalize(ip: string): string {
  const s = ip.trim().replace(/^\[|\]$/g, '');
  return s.startsWith('::ffff:') && isIP(s.slice(7)) === 4 ? s.slice(7) : s;
}

export function isTrustedProxy(ip: string): boolean {
  const t = trustList();
  if (t.all) return true;
  const n = normalize(ip);
  const fam = isIP(n);
  return fam !== 0 && t.list.check(n, fam === 4 ? 'ipv4' : 'ipv6');
}

export function clientIpFrom(req?: IncomingMessage): string {
  const peer = normalize(req?.socket?.remoteAddress ?? '');
  if (!peer) return 'unknown';
  const xf = req?.headers['x-forwarded-for'];
  const chain = (Array.isArray(xf) ? xf.join(',') : xf ?? '')
    .split(',')
    .map((s) => normalize(s))
    .filter(Boolean);
  // Walk from the nearest hop outwards while hops are trusted proxies (proxy-addr semantics).
  let ip = peer;
  while (isTrustedProxy(ip) && chain.length) ip = chain.pop()!;
  return ip;
}
