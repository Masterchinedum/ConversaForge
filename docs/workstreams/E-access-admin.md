# Workstream E — Access, sharing & organization admin

This workstream covers two areas:

- **Access and sharing:** share links, grants, embed and participant tokens, passcodes, attempt limits and the public run flows.
- **Organization admin:** members, invitations, roles, teams, branding, the audit log, usage, quotas, alerts, the billing adapter, privacy (retention, export and delete) and the account page.

Code lives in:

- `apps/api/src/modules/access/**`
- `apps/api/src/modules/admin/**`
- `apps/web/src/components/access/**`
- these web routes: `/r/[token]`, `/r/t/[token]`, `/p/[scenarioId]`, `/invite/[token]`, `/account`, `/w/[id]/scenarios/[scenarioId]/access`, and `/w/[id]/settings/{page,members,branding,usage,audit,privacy}`

## API

All workspace routes sit under `/api/workspaces/:workspaceId`. The global `WorkspaceGuard` checks that the caller is a member. Every service query also filters by `workspaceId`, so a resource that belongs to another workspace returns **404**.

### Access and sharing (`modules/access`)

| Method and path | Capability | Notes |
|---|---|---|
| `GET /scenarios/:sid/access` | scenarios.share | Data for the access page: versions for pinning, the variable allowlist, channels, privacy, the public URL, and counts. |
| `GET, POST /scenarios/:sid/links` · `PATCH, DELETE /scenarios/:sid/links/:id` | scenarios.share | Share links. A token is 32 random bytes, base64url. The list returns the full `WEB_PUBLIC_URL/r/<token>` URL. The passcode is stored as an argon2 hash and never returned. DELETE revokes the link. Create, update and revoke are audited. |
| `GET, POST /scenarios/:sid/grants` · `PATCH, DELETE …/:id` | scenarios.share | Grants to `USER` (an existing account, looked up by email), `EMAIL` or `WORKSPACE` (by id or slug). Permissions are `RUN`, `VIEW_RESULTS` or `EDIT` (EDIT implies the other two). Optional `expiresAt`. The grantee gets an email unless `notify:false`. |
| `GET, POST /access-tokens` · `DELETE /access-tokens/:id` | scenarios.share | `cfe_` (EMBED) and `cfp_` (PARTICIPANT) tokens. Only sha256 and a 12-character prefix are stored. The plaintext appears once, in the POST response. |
| `GET /api/public/links/:token` | public | Landing info: participant-safe scenario info, identity rules, whether a passcode is needed, variables the participant may supply, and branding. Returns **410** with code `link_revoked`, `link_expired`, `link_exhausted` or `scenario_unavailable`. |
| `POST /api/public/links/:token/sessions` | public | `{name?, email?, passcode?, variables?}` → `{sessionId, sessionToken}`. |
| `GET, POST /api/public/scenarios/:id[/sessions]` | public | PUBLIC and published scenarios. Uses the identity mode and per-email attempt limit from `config.access`. Honours the workspace setting `allowPublicScenarios`. |
| `GET /api/public/embed/token-info` · `POST /api/public/embed/sessions` | public (`Bearer cfe_…`) | See the trust model below. |
| `GET /api/public/participant-tokens/info` · `POST /api/public/participant-tokens/sessions` | public (`Bearer cfp_…`) | Personal invitation links (`/r/t/<token>`). Identity comes from the token. Single use by default. |
| `GET /api/me/shared-scenarios` | logged in | Active grants for my user id, my email, or any workspace I belong to. |
| `POST /api/shared/scenarios/:sid/sessions` | logged in | Needs a RUN or EDIT grant, checked at use time. |
| `GET /api/shared/scenarios/:sid/sessions` | logged in | Needs a VIEW_RESULTS or EDIT grant. Read-only list with minimal fields. |

**Checks at use time when starting a session from a link**, in order:

1. Rate limits: per IP (`PUBLIC_RUN_RATE_LIMIT_PER_HOUR`) and per link (25× that).
2. The link is active: not revoked, not expired, and uses remain.
3. Passcode. Each attempt reserves a slot in a Redis counter before argon2 verify runs: 5 per link+IP per 15 minutes, and 50 per link per hour. A correct passcode gives its slot back, so a burst of parallel guesses cannot get past the budget.
4. Identity, according to `identityMode`. `allowedEmailDomains` supports exact domains and `*.domain`. Domain rules and attempt limits require email collection; this is validated when the link is created.
5. Per-email attempt limit. Counts sessions with this `shareLinkId` and participant email, excluding CANCELLED and EXPIRED. A per-(link, email) Redis lock stops concurrent requests from getting around the limit.
6. Variables. Participant values (`?var_<key>=` from the landing page, or the form) are kept only for allowlisted keys; unknown keys are dropped silently. The link's prefilled values win. Required variables are checked **before** a use is consumed.
7. Atomic `UPDATE … WHERE useCount < maxUses AND revokedAt IS NULL AND expiresAt > now()` using a Prisma field reference. The WHERE is re-evaluated under the row lock, so racing requests cannot exceed `maxUses`.
8. `SessionsService.createSession` (B). If it fails (quota, provider), the use is given back.

**Embed trust model** (`cfe_`):

- **Minting.** Tokens are minted server-side by the customer's backend (H: `POST /api/v1/access-tokens` → `AccessService.mintToken`). They are short-lived: default 1 hour, maximum 30 days. They can be limited in uses, restricted to origins, and revoked.
- **Origin check when `allowedOrigins` is set:**
  - A direct browser call from the customer page carries that page's `Origin`, which must be on the list.
  - Calls from our own iframe carry *our* origin. For those, the frame's `parentOrigin` must be on the list. The frame reports `parentOrigin` from the browser-supplied `event.origin` of the postMessage handshake (C's `/embed/frame`).
  - With no usable origin the call is rejected (403 `origin_not_allowed`).
- **Limits.** This stops a leaked token from being used on other websites in a browser. It is **not** a defence against non-browser clients, which can forge `Origin`. Short TTLs, maxUses and revocation cover that case.
- **Identity and variables.** Participant identity comes only from the token: `externalId`, which maps to `Participant.externalId`, plus email and name. Token variables are authoritative. The page may only fill allowlisted keys the token left unset.

### Organization admin (`modules/admin`)

| Area | Routes | Capability |
|---|---|---|
| Members | `GET /members` (REVIEWER+), `PATCH /members/:membershipId {role}`, `DELETE /members/:membershipId`, `POST /leave` | members.manage (leave: any member) |
| Invitations | `GET, POST /invitations`, `POST /invitations/:id/resend` (rotates the token), `DELETE /invitations/:id` · public `GET /api/invitations/:token` · `POST /api/invitations/:token/accept` (logged in) | members.manage |
| Teams | `GET, POST /teams`, `GET, PATCH, DELETE /teams/:id`, `POST /teams/:id/members {userId \| participantId}`, `DELETE /teams/:id/members/:participantId`, `GET /teams/candidates?q=` | members.manage for writes; REVIEWER+ can read |
| Branding | `GET, PATCH /branding`, `POST, DELETE /branding/logo` (multipart field `file`) · public `GET /api/public/branding/:wsId[/logo]` | branding.manage |
| Audit | `GET /audit?action=<prefix>&actor=<email part>&actorUserId&targetType&targetId&from&to&cursor&limit`, `GET /audit/export.csv` | audit.view |
| Usage | `GET /usage/summary`, `GET /usage/ledger?kind&provider&sessionId&from&to`, `GET /usage/export.csv`, `GET /usage/sessions/:sid`, `GET /usage/alerts`, `POST /usage/alerts/:id/acknowledge` | usage.view |
| Quotas | `GET /quotas` (usage.view), `PUT /quotas {metric, limitValue, alertThresholdPct, hardLimit}` (upsert), `DELETE /quotas/:id` | usage.manage (OWNER) |
| Billing | `GET /billing` → `{provider, configured, message, plan, status, portalUrl}` | usage.view |
| Privacy | `GET, POST /privacy/requests`, `GET /privacy/requests/:id`, `POST /privacy/requests/:id/download` → a signed URL valid for 15 minutes | workspace.manage |
| Account | `GET /api/auth/sessions`, `DELETE /api/auth/sessions/:id`, `DELETE /api/auth/sessions` (all other sessions) | logged in |

Workspace settings use the existing `PATCH /api/workspaces/:id` (`maxSessionMinutes`, `defaultRetentionDays`, `allowPublicScenarios`, `allowSimulator`, `analyticsVisibleToMembers`).

**Role rules:**

- Only an OWNER can grant or revoke OWNER, invite OWNERs, or change or remove OWNERs. An ADMIN gets 403.
- The last OWNER can never be demoted, removed or leave (409 `last_owner`). This check runs in a transaction after `SELECT … FOR UPDATE` on the workspace's OWNER rows, so two owners demoting each other at the same moment still leaves exactly one owner (tested).
- Personal workspaces cannot invite (409) and cannot be left.
- Accepting an invitation requires the logged-in user's email to match the invitation, case-insensitive; otherwise 403 `invitation_email_mismatch`. Acceptance is a conditional update, so it happens once. It also links existing participants with that email to the user.

**Branding logos:**

- Only PNG, JPEG and WebP are accepted, checked by **magic bytes**. SVG is rejected, not sanitized.
- Maximum size is 2 MB (`UPLOAD_LIMITS.branding`).
- Logos are stored under `ws/<id>/branding/` and served publicly with `nosniff` and `CSP default-src 'none'`.

### Jobs: `QUEUES.adminMaintenance` (`admin-maintenance`)

- `usage.checkAlerts`: runs **hourly**. It runs `UsageService.checkAlerts` for every workspace that has quotas. Each new alert is claimed with `notifiedAt` and then emailed to OWNERs and ADMINs, with a `Notification` row created. Tested idempotent: a second run sends no email.
- `privacy.retention`: runs daily at 03:17 UTC. It handles sessions that are past `retentionUntil`, or, when that is null, past the stricter of the scenario version's `recording.retentionDays` and the workspace `defaultRetentionDays`. It only touches sessions that are terminal or more than 2 days old. For each one it:
  - deletes media objects and upload parts from storage and marks the MediaAsset `DELETED`;
  - redacts transcript text to `[redacted — retention policy]`;
  - clears tool-event args and results and non-structural session-event payloads;
  - strips `quote` from criterion and extraction evidence, keeping `turnSeq`;
  - deletes `SessionReport`;
  - sets `Session.contentRedactedAt`.

  Scores, extracted values and metadata are kept. It also deletes standalone media past `MediaAsset.retentionUntil`, such as exports. It is idempotent and logs its counts.
- `privacy.request`: one job per data request, jobId `datareq_<id>`.
  - **EXPORT** writes a JSON file with participants, sessions, transcripts, evaluations with criteria, extractions, media metadata, coach profiles, memory facts and enrollments. It is stored as an `EXPORT` MediaAsset kept for 7 days.
  - **DELETE** removes sessions (cascading), their media objects, reports and processing jobs, memory facts, coach profiles, enrollments and team memberships. It scrubs matching access tokens and turns the Participant into a tombstone with no PII. **The usage ledger is kept**; it holds no personal data.
  - Status goes PENDING → PROCESSING → COMPLETED or FAILED, with counts in `summary`. Both request and completion are audited.

I used a **separate queue instead of `QUEUES.maintenance`**. BullMQ gives each job to whichever worker takes it, so if two workstreams register handlers on one shared queue, jobs get swallowed. I added `adminMaintenance` to `QUEUES` alongside the existing entries (nothing removed or renamed).

### Billing

`BillingProvider` has `createCustomer`, `reportUsage`, `getPlan` and `portalUrl`.

- `NoneBillingProvider` is the default (`BILLING_PROVIDER=none`): every workspace is on the free plan and limits come from quotas.
- `StripeBillingProvider` is a **stub**. It always reports "not configured".
- **Needed for real Stripe billing:**
  - the `stripe` npm package (MIT);
  - `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`;
  - implementing the four methods (customers, Billing Meter events for `reportUsage`, subscription lookup, Billing Portal session);
  - a webhook route that updates `BillingAccount.plan` and `status`.
- Product logic never calls the provider directly.

## Web

- **`/r/[token]`, `/r/t/[token]`, `/p/[scenarioId]`.** These share the `RunLanding` component. It shows:
  - branding: logo, display name, primary color through `brandStyle`, support email, and "Powered by" unless hidden;
  - scenario info and instructions;
  - the identity, passcode and required-variable form.

  It forwards `?var_<key>=` parameters and shows friendly messages for expired, revoked or used links, attempt limits, disallowed domains, a wrong passcode, rate limits and quota. After start it stores the token with C's `storeSessionToken` (sessionStorage and localStorage `cf:session:<id>`) and navigates to `/live/<id>`.
- **`/invite/[token]`.** Preview of the invitation. If the user is logged out, it links to signup or login with `next`. If the user is logged in with a different email, it offers "switch account". Otherwise it shows Accept.
- **`/account`.** Profile, change password, signed-in devices (revoke one, or all others), workspaces (leave), and **Shared with me** (Start, and View results in a modal).
- **`/w/:id/scenarios/:sid/access`.** Tabs:
  - Share links: create and edit modal with all options, copy, revoke, uses and sessions, status.
  - People & workspaces (grants).
  - Embed & access tokens: create, a show-once modal, an embed snippet for C's `embed.js`, and a pointer to `docs/embed.md`.
  - Public visibility: read-only, with a link to the editor.
- **`/w/:id/settings`.** General settings plus session policies.
- **`/settings/members`.** Members and roles, invitations, and teams (team modal with a candidate search).
- **`/settings/branding`.** Form with a live preview.
- **`/settings/usage`.** Stat tiles, alerts, quota editor with progress bars, daily cost bars (with a screen-reader table), breakdown by provider and by kind, top sessions, ledger with filters, pagination and CSV export, and a billing card.
- **`/settings/audit`.** Filters, cursor paging, a details modal and CSV export.
- **`/settings/privacy`.** Retention setting and data requests (DELETE needs a typed confirmation). The status list polls while requests are in progress, and a Download button appears when an export is ready.

## Tests (actual results)

- **API integration.** Jest runs the real `AppModule` on Fastify via `app.inject`, against Postgres `conversaforge_test_e` and Redis db 5. The harness is `apps/api/test/e-harness.ts`.
  - `src/modules/access/access.e2e.spec.ts`: **23 tests**. Covered:
    - link URL, passcode never returned, audit
    - capability checks
    - landing: 410 for revoked and expired links
    - one-time links
    - 12 concurrent starts on `maxUses: 3` → exactly 3 succeed and `useCount = 3`
    - passcode brute force: sequential attempts, and a concurrent burst of 12 → 5 × 403 and 7 × 429
    - per-email limit, including CANCELLED sessions not counting
    - allowed domains, including wildcards
    - identity modes
    - variable allowlist: unknown prefill → 422, unknown participant keys dropped, prefills win
    - pinned version must belong to the scenario
    - public scenarios and their per-IP rate limit
    - embed: origin enforcement (direct and framed), expiry, revocation, maxUses, and prefix confusion (`cfs_` or `cfp_` sent to the embed endpoints)
    - mint validation (TTL cap, unknown variables, bad origins)
    - `cfp_` single use and invitation email
    - grants: EMAIL, WORKSPACE, VIEW_RESULTS versus RUN, expiry and revocation checked at use time
    - cross-workspace isolation: 404 for links, grants, tokens, members, usage and audit
  - `src/modules/admin/admin.e2e.spec.ts`: **17 tests**. Covered:
    - member list permissions
    - last-owner protection (demote, remove, leave)
    - ADMIN cannot touch OWNERs or grant OWNER
    - concurrent mutual demotion leaves one owner
    - leave; personal workspaces cannot be left or invite
    - invitations: token hashed, 7-day expiry, preview, email mismatch → 403, accept only once, resend rotates the token, revoked or expired → 410
    - teams
    - branding: bad hex → 422, SVG or spoofed type → 415, oversize → 413, public logo
    - audit filters, pagination and CSV
    - usage summary and ledger (BigInt-safe), quotas need OWNER, alert raised and emailed once
    - billing defaults to "none"
    - retention: media file deleted, turns and quotes redacted, scores kept, second run redacts 0 (idempotent), workspace default retention applied
    - export: JSON downloaded through the signed URL
    - delete: sessions, turns, memory and media file gone; participant tombstone; usage ledger kept; re-run is idempotent
    - account sessions: revoking another user's session → 404; a revoked token → 401
  - Run with `cd apps/api && redis-cli -n 5 flushdb && npx jest src/modules/access src/modules/admin --forceExit` → **40/40 pass**.
- **curl against a real API** (port 4105, real B runtime):
  - created an org, a scenario from a template and published it;
  - created a link with passcode, domain rule and prefill;
  - wrong passcode → `invalid_passcode`; gmail address → `email_domain_not_allowed`;
  - a valid start returned `cfs_…`; B's `GET /api/runtime/sessions/:id` bootstrapped it; the session had `variables = {role_title: 'Account Executive' (prefill won), participant_name: 'Pat'}` and the unknown key was dropped;
  - enqueued `usage.checkAlerts` and `privacy.retention` on the queue and both completed.
- **Playwright** (`apps/web/e2e/access-admin.spec.ts`, web on 3105 and API on 4105): **5/5 pass**.
  - Landing: wrong domain, then wrong passcode, then success → `/live/<id>` with the token in sessionStorage; a revoked link shows its message.
  - Access page: create a one-time link with a prefill, a grant, and an embed token (show-once modal).
  - Invitation: signup from `/invite` → accept → the workspace, with the CREATOR role verified.
  - Settings pages: members, branding saved with the preview updated, quota saved, audit shows `branding.updated`, a privacy export reaches Download, general settings, account devices.
  - Error states for public and unknown links.
  - Run with `E2E_WEB_URL=http://localhost:3105 E2E_API_URL=http://localhost:4105 E2E_API_LOG=<api log> npx playwright test e2e/access-admin.spec.ts`. The API log is where dev mail, including invitation links, is written.
  - The first run hit a 2-minute "Loading…" hang while other workstreams were recompiling the shared dev server. A re-run passed.

## Changes to shared files (additive)

- `schema.prisma`:
  - `Session.contentRedactedAt`
  - `UsageAlert.acknowledgedById` and `notifiedAt`
  - `DataRequest.summary` and `startedAt`
- `config/env.ts` and `.env.example`: `BILLING_PROVIDER` (`none` or `stripe`), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.
- `common/queue/queue.service.ts`: `QUEUES.adminMaintenance`.
- `main.ts`: `maxParamLength: 2048` on the Fastify adapter. This is a **foundation bug fix**: Fastify's default of 100 made **every local signed media URL** (`/api/media/signed/<token>`) fail with 414. That broke recording playback and exports for all workstreams.

## Notes for other workstreams

- **H:** inject `AccessService` (exported from `AccessModule`) and call `mintToken(workspaceId, input, principal)`. It returns `{ token, url, emailed, accessToken }`. The input follows the `MintTokenInput` zod schema and extra keys are rejected. `purpose: 'PARTICIPANT'` defaults to `maxUses: 1`, and `sendEmail: true` sends the invitation link by email.
- **A:** please add a "Share" button in the scenario editor linking to `/w/:id/scenarios/:sid/access`. The access page links back to `/w/:id/scenarios/:sid`.
- **C:**
  - `docs/embed.md` should include the origin trust model above.
  - The frame's calls (`token-info`, then `sessions` with `parentOrigin`) match the API.
  - `linkToken` embeds use the normal share-link endpoints.
- **D:**
  - After retention, `Session.contentRedactedAt` is set, the `SessionReport` row is deleted, and transcript text and evidence quotes are redacted. The review UI should handle a missing report and show "content removed by retention policy".
  - Data deletion hard-deletes sessions; the usage ledger keeps their dangling `sessionId`.
- **B:** `Session.retentionUntil` is not set at creation. Retention falls back to the scenario version's `recording.retentionDays` and the workspace default, so no change is required.
- **Everyone:** routes on a `public/...` controller must not name a path param `workspaceId`. The global `WorkspaceGuard` would then require membership (this bit `/api/public/branding/:wsId`).

## Not done or limited

- Stripe billing is a stub; see above for what it needs.
- Emails are plain text. Without `SMTP_URL`, they are written to the API log.
- The per-IP public run limit (20/hour by default) also counts failed attempts. Classrooms behind one NAT may need a higher `PUBLIC_RUN_RATE_LIMIT_PER_HOUR`.
- An embed origin check cannot stop non-browser clients that forge headers; see the trust model.
