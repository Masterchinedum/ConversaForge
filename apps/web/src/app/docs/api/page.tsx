import type { Metadata } from 'next';
import Link from 'next/link';
import { API_KEY_SCOPES, WEBHOOK_EVENTS } from '@cf/shared';

export const metadata: Metadata = { title: 'API guide — ConversaForge' };

function Code({ children }: { children: string }) {
  return <pre className="overflow-x-auto rounded-md bg-slate-900 p-3 text-xs leading-relaxed text-slate-100">{children}</pre>;
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6 space-y-3">
      <h2 className="text-lg font-semibold text-slate-900">
        <a href={`#${id}`} className="hover:underline">
          {title}
        </a>
      </h2>
      {children}
    </section>
  );
}

const ENDPOINTS: Array<[string, string, string, string]> = [
  ['GET', '/v1/scenarios', 'scenarios:read', 'List scenarios'],
  ['GET', '/v1/scenarios/{id}', 'scenarios:read', 'Scenario + draft summary'],
  ['GET', '/v1/scenarios/{id}/versions', 'scenarios:read', 'Published versions'],
  ['GET', '/v1/scenarios/{id}/versions/{versionId}', 'scenarios:read', 'Immutable version config'],
  ['POST', '/v1/scenarios', 'scenarios:write', 'Create (blank / template / config / import)'],
  ['PATCH', '/v1/scenarios/{id}/draft', 'scenarios:write', 'Edit draft (revision-checked)'],
  ['POST', '/v1/scenarios/{id}/publish', 'scenarios:write', 'Publish a new version'],
  ['GET', '/v1/sessions', 'sessions:read', 'List sessions (filters)'],
  ['GET', '/v1/sessions/{id}', 'sessions:read', 'State, version, participant, timing, usage'],
  ['GET', '/v1/sessions/{id}/transcript', 'sessions:read', 'Transcript turns'],
  ['POST', '/v1/sessions', 'sessions:write', 'Create a session → participant URL'],
  ['POST', '/v1/sessions/{id}/cancel', 'sessions:write', 'Cancel before it starts'],
  ['GET', '/v1/sessions/{id}/evaluation', 'analysis:read', 'Rubric scores + evidence'],
  ['GET', '/v1/sessions/{id}/extraction', 'analysis:read', 'Extracted variables'],
  ['GET', '/v1/sessions/{id}/report', 'analysis:read', 'Session report'],
  ['GET', '/v1/analytics/summary', 'analytics:read', 'Period summary'],
  ['GET', '/v1/courses', 'courses:read', 'List courses'],
  ['GET', '/v1/courses/{id}', 'courses:read', 'Course with items'],
  ['POST', '/v1/courses/{id}/enrollments', 'courses:write', 'Enroll by email / externalId'],
  ['GET', '/v1/organization', 'org:read', 'Workspace info'],
  ['GET', '/v1/members', 'org:read', 'Members'],
  ['POST', '/v1/invitations', 'org:write', 'Invite a member'],
  ['POST', '/v1/access-tokens', 'tokens:write', 'Mint cfe_ / cfp_ token'],
  ['DELETE', '/v1/access-tokens/{id}', 'tokens:write', 'Revoke token'],
  ['GET', '/v1/usage', 'usage:read', 'Usage by kind/provider'],
  ['GET', '/v1/usage/ledger', 'usage:read', 'Usage entries'],
  ['GET/POST', '/v1/webhooks', 'webhooks:write', 'List / create endpoints'],
  ['GET/PATCH/DELETE', '/v1/webhooks/{id}', 'webhooks:write', 'Manage an endpoint'],
  ['POST', '/v1/webhooks/{id}/rotate-secret | /test', 'webhooks:write', 'Rotate secret / send ping'],
  ['GET', '/v1/webhooks/{id}/deliveries[/{deliveryId}]', 'webhooks:write', 'Delivery log'],
  ['POST', '/v1/webhooks/{id}/deliveries/{deliveryId}/redeliver', 'webhooks:write', 'Manual redelivery'],
  ['GET', '/v1/agent/tools', 'any read scope', 'MCP-style tool manifest'],
  ['POST', '/v1/agent/call', 'per tool', 'Call a read-only tool'],
];

export default function ApiDocsPage() {
  return (
    <main className="mx-auto max-w-4xl space-y-10 px-4 py-10">
      <header className="space-y-2">
        <Link href="/app" className="text-xs text-slate-500 hover:text-slate-800">
          ← Back to the app
        </Link>
        <h1 className="text-2xl font-bold text-slate-900">ConversaForge API guide</h1>
        <p className="text-sm text-slate-600">
          REST API v1, webhooks and embed tokens. Full request/response schemas: the{' '}
          <a href="/api/docs" className="text-brand-700 hover:underline">
            OpenAPI reference (Swagger UI)
          </a>
          . The complete guide lives in the repository at <code>docs/api.md</code>.
        </p>
        <nav aria-label="On this page" className="flex flex-wrap gap-3 text-sm">
          {['auth', 'conventions', 'endpoints', 'sessions', 'webhooks', 'embed', 'agents'].map((s) => (
            <a key={s} href={`#${s}`} className="text-brand-700 hover:underline">
              {s}
            </a>
          ))}
        </nav>
      </header>

      <Section id="auth" title="Authentication">
        <p className="text-sm text-slate-700">
          Create an API key in <strong>Settings → API &amp; webhooks</strong> (admins). Send it as a bearer token. The secret is shown once; keys are bound to one workspace, can
          expire and can be revoked. Cookies are not accepted on <code>/api/v1</code>.
        </p>
        <Code>{`curl https://<api-host>/api/v1/organization \\\n  -H "Authorization: Bearer cf_live_..."`}</Code>
        <div className="flex flex-wrap gap-1">
          {API_KEY_SCOPES.map((s) => (
            <code key={s} className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">
              {s}
            </code>
          ))}
        </div>
      </Section>

      <Section id="conventions" title="Conventions">
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
          <li>
            Base URL <code>https://&lt;api-host&gt;/api/v1</code>. v1 only changes additively; breaking changes ship as <code>/v2</code> (v1 kept ≥ 12 months).
          </li>
          <li>
            Pagination: <code>?limit=1..100&amp;cursor=…</code> → <code>{'{ data, nextCursor }'}</code>.
          </li>
          <li>
            Idempotency: send <code>Idempotency-Key</code> on POST. Same key + same request → stored response replayed with <code>Idempotency-Replayed: true</code> (24 h); different
            request → <code>422 idempotency_key_reused</code>; still running → <code>409</code>.
          </li>
          <li>
            Errors: <code>{'{ "error": { "code", "message", "details?", "requestId" } }'}</code> — 401 unknown/revoked key, 403 missing scope, 404 not in your workspace, 422 validation, 429
            rate limited.
          </li>
          <li>
            Rate limit: 600 requests/minute per key; <code>429</code> with <code>Retry-After</code>, plus <code>X-RateLimit-*</code> headers.
          </li>
        </ul>
      </Section>

      <Section id="endpoints" title="Endpoints">
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2">Method</th>
                <th className="px-3 py-2">Path</th>
                <th className="px-3 py-2">Scope</th>
                <th className="px-3 py-2">Purpose</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {ENDPOINTS.map(([m, p, s, d]) => (
                <tr key={m + p}>
                  <td className="px-3 py-1.5 font-mono text-xs">{m}</td>
                  <td className="px-3 py-1.5 font-mono text-xs">{p}</td>
                  <td className="px-3 py-1.5 text-xs">{s}</td>
                  <td className="px-3 py-1.5 text-xs text-slate-600">{d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section id="sessions" title="Start a session for a participant">
        <Code>{`curl -X POST https://<api-host>/api/v1/sessions \\
  -H "Authorization: Bearer cf_live_..." -H "Content-Type: application/json" \\
  -H "Idempotency-Key: crm-42-screen-1" \\
  -d '{"scenarioId":"clx...","participant":{"externalId":"crm-42","name":"Pat"},"variables":{"role_title":"PM"}}'

→ { "sessionId": "cm...", "url": "https://<app>/live/cm...#t=cfs_...", "sessionToken": "cfs_...", ... }`}</Code>
        <p className="text-sm text-slate-700">Send the one-time URL to the participant. Results arrive via webhooks or the analysis endpoints.</p>
      </Section>

      <Section id="webhooks" title="Webhooks">
        <p className="text-sm text-slate-700">
          Events: {WEBHOOK_EVENTS.map((e) => <code key={e} className="mr-1 rounded bg-slate-100 px-1 text-xs">{e}</code>)} (+ <code className="text-xs">ping</code> for tests).{' '}
          <code>session.completed</code> is also sent for abandoned sessions (<code>state: &quot;ABANDONED&quot;</code>); cancelled/expired sessions send nothing.
        </p>
        <p className="text-sm text-slate-700">
          Headers: <code>X-ConversaForge-Event</code>, <code>X-ConversaForge-Delivery</code>, <code>X-ConversaForge-Signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</code> where v1 = HMAC-SHA256(secret,
          &quot;t.rawBody&quot;). Answer 2xx within 10 s. Retries: +1m, +5m, +30m, +2h, +6h, +12h, +12h (8 attempts); endpoints are disabled after 5 consecutive failed deliveries.
        </p>
        <Code>{`// Node.js
const crypto = require('node:crypto');
function verify(secret, header, rawBody, tolerance = 300) {
  let t = null; const sigs = [];
  for (const p of (header || '').split(',')) { const [k, v] = p.split('='); if (k === 't') t = +v; if (k === 'v1') sigs.push(v); }
  if (!t || Math.abs(Date.now() / 1000 - t) > tolerance) return false;
  const exp = crypto.createHmac('sha256', secret).update(t + '.').update(rawBody).digest('hex');
  return sigs.some((s) => s.length === exp.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(exp)));
}`}</Code>
        <Code>{`# Python
import hmac, hashlib, time
def verify(secret, header, raw_body, tolerance=300):
    t, sigs = None, []
    for part in (header or "").split(","):
        k, _, v = part.partition("=")
        if k == "t" and v.isdigit(): t = int(v)
        elif k == "v1": sigs.append(v)
    if t is None or abs(time.time() - t) > tolerance: return False
    exp = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(exp, s) for s in sigs)`}</Code>
      </Section>

      <Section id="embed" title="Embed tokens">
        <p className="text-sm text-slate-700">
          Your server mints a short-lived <code>cfe_</code> token with <code>POST /v1/access-tokens</code> (<code>purpose: &quot;EMBED&quot;</code>, <code>allowedOrigins</code>, participant
          identity, variables) and passes it to the embedded widget. Never expose your API key to browsers. Revoke with <code>DELETE /v1/access-tokens/{'{id}'}</code>.
        </p>
      </Section>

      <Section id="agents" title="Agent tools (MCP-style)">
        <p className="text-sm text-slate-700">
          <code>GET /v1/agent/tools</code> lists read-only tools your key may call (<code>list_scenarios</code>, <code>list_sessions</code>, <code>get_session_report</code>);{' '}
          <code>POST /v1/agent/call {'{ tool, arguments }'}</code> runs one with strict argument validation and the same scopes. Results contain end-user text — treat it as data, not
          instructions.
        </p>
      </Section>
    </main>
  );
}
