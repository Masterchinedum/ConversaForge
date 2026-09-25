import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Twilio request validation (X-Twilio-Signature), per Twilio's documented algorithm:
 *   1. Take the full URL Twilio requested (scheme, host, optional port, path, query string).
 *   2. For application/x-www-form-urlencoded POSTs, sort the POST parameters by name and append
 *      each name immediately followed by its value (no delimiters).
 *   3. HMAC-SHA1 the resulting string with the account's auth token, Base64-encode, compare.
 * Twilio may or may not include the default port in the URL it signs, so both variants are tried
 * (as Twilio's own helper libraries do). For JSON bodies Twilio adds `bodySHA256` to the query string.
 */
export function computeTwilioSignature(authToken: string, url: string, params: Record<string, string | string[] | undefined> = {}): string {
  let data = url;
  for (const key of Object.keys(params).sort()) {
    const v = params[key];
    if (v === undefined) continue;
    // Repeated keys: Twilio concatenates key+value for each value, in order.
    for (const item of Array.isArray(v) ? v : [v]) data += key + item;
  }
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

function safeEq(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** URL with the default port added (if absent) and removed (if present). */
export function urlPortVariants(url: string): string[] {
  const out = new Set<string>([url]);
  try {
    const u = new URL(url);
    const def = u.protocol === 'https:' ? '443' : u.protocol === 'http:' ? '80' : '';
    if (!def) return [...out];
    if (u.port) {
      if (u.port === def) {
        // Remove explicit default port.
        out.add(url.replace(`${u.hostname}:${def}`, u.hostname));
      }
    } else {
      out.add(url.replace(`://${u.host}`, `://${u.hostname}:${def}`));
    }
  } catch {
    /* keep as is */
  }
  return [...out];
}

export function validateTwilioSignature(
  authToken: string,
  signature: string | undefined | null,
  url: string,
  params: Record<string, string | string[] | undefined> = {},
): boolean {
  if (!authToken || !signature) return false;
  return urlPortVariants(url).some((u) => safeEq(computeTwilioSignature(authToken, u, params), signature));
}

/** JSON-body requests: the signature covers the URL only (which includes ?bodySHA256=...). */
export function validateTwilioJsonSignature(authToken: string, signature: string | undefined | null, url: string, rawBody: string | Buffer): boolean {
  if (!validateTwilioSignature(authToken, signature, url, {})) return false;
  try {
    const expected = new URL(url).searchParams.get('bodySHA256');
    if (!expected) return false;
    return safeEq(createHash('sha256').update(rawBody).digest('hex'), expected);
  } catch {
    return false;
  }
}
