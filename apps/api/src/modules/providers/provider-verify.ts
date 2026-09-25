import type { ProviderConfig, ProviderId } from './provider-catalog';

/**
 * Lightweight authenticated "who am I" calls used to verify a stored credential.
 * Never logs or returns the secret; error messages never echo response bodies verbatim beyond a short,
 * sanitized provider message.
 */

export type VerifyOutcome =
  | { result: 'valid'; httpStatus: number; message: string }
  | { result: 'invalid'; httpStatus: number; message: string }
  | { result: 'error'; httpStatus: number | null; message: string }
  | { result: 'unsupported'; httpStatus: null; message: string };

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

export const VERIFY_TIMEOUT_MS = 10_000;

export function verifyRequest(
  provider: ProviderId,
  secret: string,
  config: ProviderConfig,
): { url: string; headers: Record<string, string> } | null {
  switch (provider) {
    case 'anthropic':
      return { url: 'https://api.anthropic.com/v1/models?limit=1', headers: { 'x-api-key': secret, 'anthropic-version': '2023-06-01' } };
    case 'openai':
      return { url: 'https://api.openai.com/v1/models', headers: { authorization: `Bearer ${secret}` } };
    case 'deepgram':
      return { url: 'https://api.deepgram.com/v1/projects', headers: { authorization: `Token ${secret}` } };
    case 'elevenlabs':
      return { url: 'https://api.elevenlabs.io/v1/user', headers: { 'xi-api-key': secret } };
    case 'twilio': {
      const { accountSid, authToken } = parseTwilioSecret(secret, config);
      if (!accountSid || !authToken) return null;
      return {
        url: `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}.json`,
        headers: { authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}` },
      };
    }
    case 'recall': {
      const region = config.region ?? 'us-east-1';
      return { url: `https://${region}.recall.ai/api/v1/bot/?limit=1`, headers: { authorization: `Token ${secret}` } };
    }
    default:
      return null;
  }
}

/** Twilio secrets are stored as JSON {accountSid, authToken}; "sid:token" (env format) is accepted too. */
export function parseTwilioSecret(secret: string, config?: ProviderConfig): { accountSid?: string; authToken?: string } {
  try {
    const j = JSON.parse(secret);
    if (j && typeof j === 'object') return { accountSid: j.accountSid ?? config?.accountSid, authToken: j.authToken };
  } catch {
    /* not JSON */
  }
  const i = secret.indexOf(':');
  if (i > 0) return { accountSid: secret.slice(0, i), authToken: secret.slice(i + 1) };
  return { accountSid: config?.accountSid, authToken: secret };
}

export async function verifyCredential(
  provider: ProviderId,
  secret: string,
  config: ProviderConfig,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  timeoutMs = VERIFY_TIMEOUT_MS,
): Promise<VerifyOutcome> {
  const req = verifyRequest(provider, secret, config);
  if (!req) {
    return provider === 'twilio'
      ? { result: 'invalid', httpStatus: 0, message: 'Account SID and auth token are both required' }
      : { result: 'unsupported', httpStatus: null, message: 'Automatic verification is not available for this provider' };
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(req.url, { method: 'GET', headers: { ...req.headers, accept: 'application/json', 'user-agent': 'ConversaForge/1.0' }, signal: ac.signal });
    const body = await res.text().catch(() => '');
    const hint = providerMessage(body, secret);
    if (res.status >= 200 && res.status < 300) return { result: 'valid', httpStatus: res.status, message: 'Credential verified' };
    if (res.status === 403 && !looksLikeJson(body)) {
      // A non-JSON 403 comes from a proxy/firewall between us and the provider, not from the provider.
      return { result: 'error', httpStatus: 403, message: 'The request was blocked before reaching the provider (HTTP 403 from a proxy or firewall). Check outbound network access.' };
    }
    if (res.status === 401 || res.status === 403) {
      return { result: 'invalid', httpStatus: res.status, message: `The provider rejected the credential (HTTP ${res.status})${hint ? `: ${hint}` : ''}` };
    }
    if (res.status === 404 && provider === 'twilio') {
      return { result: 'invalid', httpStatus: res.status, message: 'Twilio account not found — check the Account SID' };
    }
    if (res.status === 429) return { result: 'error', httpStatus: res.status, message: 'The provider is rate limiting requests; try again shortly' };
    return { result: 'error', httpStatus: res.status, message: `Unexpected response from the provider (HTTP ${res.status})${hint ? `: ${hint}` : ''}` };
  } catch (e: any) {
    const aborted = e?.name === 'AbortError' || ac.signal.aborted;
    return {
      result: 'error',
      httpStatus: null,
      message: aborted ? `The provider did not respond within ${Math.round(timeoutMs / 1000)} s` : `Could not reach the provider (${String(e?.cause?.code ?? e?.code ?? e?.message ?? 'network error').slice(0, 80)})`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function looksLikeJson(body: string): boolean {
  const t = body.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

/** Short, secret-free message from a provider error body. */
function providerMessage(body: string, secret: string): string {
  if (!body) return '';
  let msg = '';
  try {
    const j = JSON.parse(body);
    msg = j?.error?.message ?? j?.message ?? j?.detail?.message ?? j?.detail ?? j?.err_msg ?? j?.error ?? '';
    if (typeof msg !== 'string') msg = '';
  } catch {
    msg = '';
  }
  msg = msg.replace(/[\u0000-\u001F\u007F]/g, ' ').slice(0, 160);
  if (secret && secret.length >= 6) msg = msg.split(secret).join('[redacted]');
  // Providers sometimes echo partial keys ("Incorrect API key provided: sk-abc***xyz").
  msg = msg.replace(/\b(sk-[A-Za-z0-9_-]{2})[A-Za-z0-9_*-]{6,}/g, '$1…');
  return msg;
}
