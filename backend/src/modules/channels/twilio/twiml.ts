/**
 * Minimal TwiML builder. All text and attribute values are XML-escaped; nothing user-provided is
 * ever concatenated raw into the document.
 */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Strip characters that are not allowed in XML 1.0.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');
}

function attrs(a: Record<string, string | number | boolean | undefined>): string {
  return Object.entries(a)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${xmlEscape(String(v))}"`)
    .join('');
}

export type TwimlVerb =
  | { verb: 'Say'; text: string; language?: string; voice?: string }
  | { verb: 'Pause'; length: number }
  | { verb: 'Hangup' }
  | { verb: 'Stream'; url: string; parameters: Record<string, string>; statusCallback?: string }
  | { verb: 'DialNumber'; number: string; callerId?: string; timeout?: number }
  | { verb: 'DialSip'; uri: string; timeout?: number };

export function twiml(verbs: TwimlVerb[]): string {
  const body = verbs
    .map((v) => {
      switch (v.verb) {
        case 'Say':
          return `<Say${attrs({ language: v.language, voice: v.voice })}>${xmlEscape(v.text)}</Say>`;
        case 'Pause':
          return `<Pause${attrs({ length: Math.max(1, Math.min(60, Math.round(v.length))) })}/>`;
        case 'Hangup':
          return '<Hangup/>';
        case 'Stream': {
          const params = Object.entries(v.parameters)
            .map(([name, value]) => `<Parameter${attrs({ name, value })}/>`)
            .join('');
          return `<Connect><Stream${attrs({ url: v.url, statusCallback: v.statusCallback })}>${params}</Stream></Connect>`;
        }
        case 'DialNumber':
          return `<Dial${attrs({ callerId: v.callerId, timeout: v.timeout })}><Number>${xmlEscape(v.number)}</Number></Dial>`;
        case 'DialSip':
          return `<Dial${attrs({ timeout: v.timeout })}><Sip>${xmlEscape(v.uri)}</Sip></Dial>`;
      }
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
}

/** Spoken + hang up (used for every "cannot take this call" path — never a simulated conversation). */
export function sayAndHangup(text: string, language?: string): string {
  return twiml([{ verb: 'Say', text, language }, { verb: 'Hangup' }]);
}

/** Twilio's <Say> supports a fixed set of language codes; fall back to en-US for anything else. */
export function sayLanguage(lang: string | undefined): string {
  const l = (lang || 'en-US').trim();
  return /^[a-z]{2}-[A-Z]{2}$/.test(l) ? l : 'en-US';
}

/** E.164 phone number: + followed by 8–15 digits, no leading zero in the country code. */
export const E164_RE = /^\+[1-9]\d{7,14}$/;

export function normalizePhone(raw: string): string | null {
  const s = String(raw ?? '').trim().replace(/[\s().-]/g, '');
  const withPlus = s.startsWith('00') ? `+${s.slice(2)}` : s;
  return E164_RE.test(withPlus) ? withPlus : null;
}

/** SIP URI for <Dial><Sip>: sip:user@host[:port][;params] — no whitespace or markup. */
export const SIP_RE = /^sips?:[A-Za-z0-9._~%!$&'()*+,;=:-]+@[A-Za-z0-9.-]+(:\d{1,5})?(;[A-Za-z0-9=._-]+)*$/;
