# ConversaForge — Application Security Review

Date: 2026-09-25 · Reviewer: independent AppSec review (code review plus live exploit testing) · Scope: whole monorepo.

## 1. Scope

| Area | Covered |
|---|---|
| API (`apps/api`, NestJS 11 / Fastify 5) | Every controller and guard, tenant scoping of Prisma and raw SQL, the token types (`cf_session`, `cf_live_`, `cfs_`, `cfe_`, `cfp_`, share-link, course, invitation, reset), uploads and media serving, SSRF guards, webhooks and provider callbacks, WebSocket gateways, LLM prompt construction, CSV/PDF exports, rate limits, the privacy and retention jobs |
| Web (`apps/web`, Next.js 15) | XSS sinks, URL handling, redirects, `embed.js` and the `/embed/frame` postMessage protocol, security headers, where tokens are stored |
| Shared (`packages/shared`) | Scenario schema validation, variable resolution and sanitizing |
| Dependencies | `pnpm audit --prod` |

Out of scope: infrastructure (TLS termination, WAF, bucket policies, secret storage) and the third-party providers themselves.

## 2. Method

1. I read `docs/ARCHITECTURE.md` and the workstream notes, then worked through the checklist: tenant isolation, authorization, tokens, injection, SSRF, uploads, secrets, abuse, CSRF/CORS, business invariants, privacy and dependencies.
2. I extracted a route inventory from all controllers (path, `@Public`, `@RequireCapability`, `@ApiScopes`) and checked every route that has no `:workspaceId` for its own authorization.
3. I grepped for risky patterns: `findUnique({ where: { id`, raw SQL, `new RegExp`, outbound `fetch`/`https.request`, `Content-Type`/`Content-Disposition`, `dangerouslySetInnerHTML`, `href={…}`, `location.*`, `postMessage`.
4. Live testing: a separate database (`conversaforge_sec`, seeded) and the API on port 4201. An attacker account with its own workspace sent requests that referenced the victim's scenario, session, participant and course ids. All of them returned 404 or 422. I also checked CSRF (evil and `null` Origin both got 403), the media response headers, and the email-verification flow end to end.
5. Each fix is minimal and ships with a jest or vitest test. The full API suite, both TypeScript checks and the shared tests pass.

## 3. Findings

Severity reflects the impact in this multi-tenant SaaS: H = cross-user data or access, or platform-wide denial of service; M = meaningful but constrained; L = hardening.

### H-1 Account emails were trusted without verification (account squatting leads to inherited data and access)

- **Where:** `modules/auth/auth.service.ts` (signup linked every `Participant` row with the same email, in every workspace, to the new account); `modules/access/grants.service.ts` (EMAIL grants matched `user.email`); `modules/courses/participants.ts` and `learn.service.ts` (email-assigned enrollments claimed by an account with that email); `modules/courses/enrollments.service.ts` (an email assignment was bound to an existing account with that address); the self-run and shared-run participant upsert (the account attached anonymous rows for that email). `User.emailVerifiedAt` existed but was never set.
- **Impact:** An attacker who signs up with a victim's address before the victim does gets:
  - the victim's share-link session history and transcripts, through `GET /api/me/sessions` and `/me/sessions/:id/report`;
  - every scenario shared with that email (RUN, VIEW_RESULTS with other participants' names and scores, or EDIT);
  - the victim's email-assigned course enrollments.
- **Fix:**
  - Added email verification. On signup the API emails a stateless HMAC-signed token (`CryptoService.signPayload`, purpose `email_verify`, bound to the user id and email, 3-day TTL, idempotent). New endpoints: `POST /api/auth/verify-email {token}` (public, rate-limited) and `POST /api/auth/resend-verification` (5 per hour per user).
  - Verification links pre-existing participant rows. So do a completed password reset and an accepted invitation, because each proves control of the mailbox.
  - The principal now carries `emailVerified`. `verifiedEmail(principal)` in `common/auth/principal.ts` is the only email used for identity linking. It gates email grants, learner references, the coach `me` profile, member self-run, shared runs and email assignments.
  - `GET /auth/me` returns `emailVerifiedAt`. The web app adds the `/verify-email` page and an "unverified" banner with a resend button in the workspace layout. Seed users are pre-verified.
  - No schema change: tokens are stateless.
- **Tests:**
  - `access.e2e.spec.ts`, "SECURITY: an unverified account cannot claim …": no grant access, no linked history, then after verification access is granted; a forged token for another address is rejected.
  - `courses.int.spec.ts`, "SECURITY: … UNVERIFIED email cannot claim an email assignment".
  - The e2e harness users are verified by default (`{ verified: false }` opts out).

### H-2 ReDoS: author regexes run against participant input on the shared event loop

- **Where:**
  - `packages/shared/src/variables.ts`: runtime variable `pattern`, input up to 2,000 characters from public share-link or embed callers.
  - `modules/runtime/tools/json-schema.ts`: custom-function argument `pattern`, where the input comes from the model or, in realtime mode, straight from the client.
  - `modules/providers/json-schema.ts`.
  - Validation only rejected a narrow `(x+)+` shape (functions) or nothing at all (variables).
- **Impact:** One tenant, or one public participant against a tenant with a bad pattern, can freeze the API process for every tenant. For example, `(a+)+` with 60 × `a!` never finishes.
- **Fix:**
  - Added `packages/shared/src/safe-regex.ts` with `regexPatternRisk()`. It rejects nested or alternated quantified groups, backreferences and more than four unbounded quantifiers. Scenario validation (now compiled with the same `u` flag as the runtime) and function-schema validation both use it.
  - At runtime every evaluation goes through `common/security/regex-guard.ts`: `vm` with a 50 ms timeout, which V8 honours inside the regex engine. It is installed into `@cf/shared` through `setPatternTester`. A timeout counts as "no match", so it fails closed.
- **Tests:** `packages/shared/src/safe-regex.test.ts` (19 cases) and `apps/api/src/common/security/regex-guard.spec.ts` (an evil pattern is interrupted in about 50 ms, and a stored evil variable pattern fails closed quickly).

### M-1 Coach memory crossed between people who typed the same email

- **Where:** `modules/coach/memory.service.ts`. Anonymous share-link and public runs reuse the anonymous `Participant` with the typed, unverified email. Memory facts were learned from and injected into those sessions.
- **Impact:** Anyone who types a learner's email on a public link gets that learner's coaching notes in the live prompt, where the model can be coaxed to reveal them. This breaks invariant 7 (learner memory isolation).
- **Fix:** Memory is only read, profiled or learned for participants with a trusted identity: an account (`userId`) or an `externalId` set by a server-side caller (API, embed or participant token, phone).
- **Test:** `memory.int.spec.ts`, "SECURITY: anonymous (typed-email) participants get no memory".

### M-2 Media proxy echoed the stored MIME type inline on the app origin

- **Where:** `modules/media/media.controller.ts` and `common/storage/storage.service.ts` (S3 presign). The web app proxies `/api/*`, so media is same-origin with the app.
- **Impact:** Any current or future upload path that stores an active type (`text/html`, `image/svg+xml`, XML) would become stored XSS on the app origin, with access to session cookies' requests and to participant tokens in local storage. The current upload paths sniff content, so this is defence in depth, but the proxy trusted a database field.
- **Fix:**
  - `safeServeType()` keeps an inline allowlist of passive types: raster images, audio/video, PDF, and text (served as `text/plain; charset=utf-8`). Everything else is served as `application/octet-stream` with `Content-Disposition: attachment`.
  - Added `Content-Security-Policy: default-src 'none'; …; sandbox` (not applied to PDFs, which browser viewers refuse to render when sandboxed) and `Referrer-Policy: no-referrer`.
  - The same policy applies to S3 presigned URLs (`ResponseContentType` and `ResponseContentDisposition`).
- **Verified live:** a Markdown document containing `<script>` is served as `text/plain` with a sandbox CSP.

### M-3 Client-relayed realtime tool calls were unthrottled

- **Where:** `modules/runtime/engine/session-engine.ts` `onRealtimeToolCall`. In OpenAI Realtime mode the participant's browser relays tool calls, and the server executes them.
- **Impact:** A scripted anonymous client could make the server call customer custom-function endpoints, knowledge search and database writes at WebSocket speed (40 messages/s).
- **Fix:** Per-session caps of 20 calls per rolling minute and 300 per session (`REALTIME_TOOL_CALLS`). Calls over the cap get a tool-error result and are not executed.
- **Test:** `runtime.e2e.spec.ts` (realtime flow: a burst of 22 calls, the 22nd is refused).

### M-4 Prompt-injection escape from the transcript data block

- **Where:** `modules/analysis/prompts.ts` (`<transcript>…</transcript>` for scoring and extraction) and `modules/coach/memory.service.ts` (`<<<TRANSCRIPT … TRANSCRIPT>>>`).
- **Impact:** A participant could type `</transcript><rubric>…` to close the data block and give the scorer or the memory extractor instructions, for example to inflate their own score or plant facts.
- **Fix:** Angle brackets in turn text become look-alike guillemets (`neutralizeMarkup`). Evidence matching already normalizes punctuation away, so verbatim quotes still verify.
- **Test:** `evidence.spec.ts`, "SECURITY: transcript prompt-injection containment".

### M-5 Open redirect after login and signup

- **Where:** `apps/web/src/app/(auth)/login/page.tsx` and `signup/page.tsx`. The check `next.startsWith('/') && !startsWith('//')` let `/\evil.com` through, which browsers treat as `//evil.com`.
- **Fix:** Both pages use the existing `safeReturnUrl()` (same-origin check, rejects backslashes and control characters). Web `tsc` is clean.

### L-1 WebSocket hello rate limit was keyed on a spoofable `X-Forwarded-For`

- **Where:** `modules/runtime/runtime.gateway.ts`.
- **Fix:** Added `common/security/client-ip.ts`. It honours XFF only when the socket peer matches `TRUST_PROXY` (the same setting Fastify uses), with proxy-addr semantics.
- **Test:** `client-ip.spec.ts`.

### L-2 Bearer links logged in production when SMTP is unset

- **Where:** `common/mail/mail.service.ts`. The dev fallback logged full bodies: reset, verification and invitation links, and personal run links.
- **Fix:** In production, only the recipient and subject are logged, with a warning.

### L-3 Session cookie not `Secure` by default in production

- **Fix:** `auth.controller.ts` sets `secure: env.COOKIE_SECURE || NODE_ENV === 'production'`.

### L-4 Forgot-password had only a per-IP limit

- **Impact:** Reset mail could be sent to one inbox repeatedly from rotating IPs.
- **Fix:** Added a per-address limit of 3 per hour.

### L-5 API keys kept working after their workspace was soft-deleted

- **Fix:** `AuthGuard.resolveApiKey` checks `workspace.deletedAt`.

### L-6 Unvalidated `X-Request-Id`

- **Issue:** The client-supplied request id was echoed into logs and error bodies without validation.
- **Fix:** `main.ts` accepts it only if it matches `^[A-Za-z0-9._:-]{1,128}$`; otherwise it uses a UUID.

### Verified as correct (no change needed)

- **Tenant isolation:** the workspace guard returns 404 for non-members. Nested ids in bodies are validated against the workspace: scenario, version, course, asset and document ids, team members, privacy subjects, enrollment and attempt ids, grant targets and token scenarios. The raw SQL in knowledge FTS and analytics is parameterized and workspace-filtered.
- **Tokens:**
  - Only SHA-256 hashes are stored for `cf_session`, `cfs_`, `cfe_`, `cfp_`, invitation and reset tokens.
  - Session tokens are compared in constant time.
  - Expiry and revocation are checked at use time.
  - Share-link and access-token uses are consumed with conditional `UPDATE`s, so there are no `maxUses` races.
  - Passcode attempt budgets are reserved before verification.
  - Per-email attempt limits are serialized with a Redis lock.
- **Embed trust model:** the token travels by postMessage to a pinned origin. The frame checks `ev.source`/`ev.origin` against `ancestorOrigins`, and the server re-checks allowed origins.
- **SSRF:**
  - Custom functions: https only, host allowlist, DNS resolved and pinned (defeats rebinding), IPv4 and IPv6 blocklists including mapped, NAT64 and 6to4 addresses, no redirects, size and time caps.
  - Webhooks: `safeLookup` at connect time, no redirects.
  - Provider verification and Recall only call fixed hosts or allowlisted regions.
  - ElevenLabs `voiceId` is validated.
- **Uploads:** size limits, magic-byte sniffing (PDF, DOCX, images, video), document parsing in a worker thread with memory and time limits, path-traversal-safe storage keys, no SVG logos.
- **Webhooks in:** Twilio signatures (with port variants and AccountSid check) and Svix (5-minute tolerance, constant-time comparison).
- **Secrets:** provider keys, webhook secrets and function headers are AES-256-GCM encrypted, returned masked or last-4 only, and redacted in audit metadata.
- **CSV exports:** all three CSV helpers neutralize formulas (`= + - @` tab CR). `Content-Disposition` file names are sanitized.
- **CSRF and CORS:** cookie requests that change state require an allowed Origin/Referer (verified: evil and `null` origins get 403). Cookies are `SameSite=Lax` and `httpOnly`. CORS is an allowlist. The WebSocket is authenticated by an in-band token, not cookies.
- **Web XSS:** no `dangerouslySetInnerHTML` or `srcDoc`. React 19 blocks `javascript:` URLs, and course LINK URLs are https-only on the server. Tokens never appear in URLs except personal links. `Referrer-Policy: strict-origin-when-cross-origin`, and `no-referrer` on logos.
- **Business invariants:** the `ScenarioVersion` immutability trigger, sessions pinned to a version, consent-gated recordings and analysis skipped when declined, quota checked at session create and start, the participant report restricted by version visibility, and last-owner protection with row locks. Only owners can grant the owner role.

## 4. Files changed

- **API:**
  - `common/auth/{auth.guard.ts,principal.ts}`
  - `common/mail/mail.service.ts`
  - `common/storage/storage.service.ts`
  - `common/security/{regex-guard.ts,client-ip.ts}` plus their specs
  - `main.ts`
  - `modules/auth/{auth.service.ts,auth.controller.ts}`
  - `modules/access/grants.service.ts`, `access.util.ts`
  - `modules/admin/members.service.ts`
  - `modules/courses/{learn.controller.ts,learn.service.ts,participants.ts,enrollments.service.ts}`
  - `modules/coach/{coach.controller.ts,memory.service.ts}`
  - `modules/runtime/{sessions.controller.ts,sessions.service.ts,runtime.gateway.ts,engine/session-engine.ts,tools/json-schema.ts}`
  - `modules/providers/json-schema.ts`
  - `modules/scenarios/scenario-preview.ts`
  - `modules/media/media.controller.ts`
  - `modules/analysis/prompts.ts`
  - `prisma/seed.ts`
  - Tests: `test/e-harness.ts`, `access.e2e.spec.ts`, `courses.int.spec.ts`, `memory.int.spec.ts`, `runtime.e2e.spec.ts`, `evidence.spec.ts`
- **Shared:** `src/safe-regex.ts` (new, exported), `src/variables.ts`, `src/scenario-config.ts`, `src/index.ts`, `src/safe-regex.test.ts`. The package has been rebuilt.
- **Web:**
  - `app/(auth)/verify-email/page.tsx` (new)
  - `components/account/VerifyEmailBanner.tsx` (new)
  - `app/w/[workspaceId]/layout.tsx` (banner)
  - `lib/workspace.tsx` (`emailVerifiedAt` type)
  - `app/(auth)/{login,signup}/page.tsx`
- **No Prisma schema or migration changes.**

## 5. Residual risks and recommendations

1. **Existing accounts after deploy.** All current users have `emailVerifiedAt = NULL`, so email grants and email assignments pause until each user clicks the verification link (the banner asks them to). Do not bulk-backfill: that would re-open H-1. If needed, backfill only accounts with independent proof of mailbox control, such as an accepted invitation or a completed password reset.
2. **Realtime (client-side) voice mode is not tamper-proof.** The participant's browser relays transcripts and tool calls, so a technical participant can forge their own transcript and change their own score. For high-stakes assessments, use server-mediated voice or text modes, or flag realtime sessions in reviews.
3. **Author variables are substituted into author instructions by design.** Participant-supplied allowlisted values reach the system prompt. They are sanitized (brackets, braces and backticks stripped, length-capped), but they remain a prompt-injection surface. Keep allowlists tight.
4. **Account enumeration and lockout.** Signup returns 409 for an existing email, and the per-email login limit (10 per 15 minutes) can briefly lock a user out. Both are accepted trade-offs; consider generic signup responses and CAPTCHA or step-up after failures.
5. **No Content-Security-Policy on the web app.** Participant tokens live in `localStorage`/`sessionStorage`. Add a nonce-based CSP, including `frame-ancestors` for the non-embed routes.
6. **Signed media URLs are bearer URLs** valid for 15 to 60 minutes. Keep TTLs short and avoid putting them into emails.
7. **Dependencies** (`pnpm audit --prod`: 5 high, 12 moderate, 1 low). I did not upgrade anything: other agents share the lockfile and `node_modules`, so a `pnpm install` would disrupt concurrent work. Recommended:
   - `yaml` 2.8.1 → ≥ 2.8.3 (same major; deep-nesting stack overflow in YAML import).
   - `fastify` 5.11.3 → ≥ 5.12.1 (same major).
   - `nodemailer` 7.0.13 → 9.x (major; several CRLF/header-injection and address-parser advisories). Our inputs are validated emails and fixed headers, so exposure is low, but upgrade and re-test mail.
   - `postcss` 8.4.31, nested in Next (build-time only): update Next.
   - `deepmerge-ts` 7 (transitive of Prisma tooling): update when Prisma does.
8. **Infrastructure:**
   - Put a WAF or edge rate limiting in front of the API and web.
   - Keep `ENCRYPTION_KEY` and `SIGNING_SECRET` in a secrets manager and plan key rotation (the ciphertext format is versioned `v1:` but there is no rotation tooling yet).
   - Private buckets with SSE and public access blocked.
   - Malware scanning for uploads.
   - SPF, DKIM and DMARC for outgoing mail.
   - Centralized logs with redaction.
   - An external penetration test before general availability, focused on realtime/embed flows and multi-tenant isolation.
9. **Anonymous participants are grouped by typed email.** Reviewers may see sessions from different people under one participant. This is a data-quality issue, not a leak (memory is now disabled for these participants); consider verifying emails on share links (magic link) for scenarios that need identity.
