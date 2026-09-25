# ConversaForge — Status & handoff

_Last updated: 2026-09-26 (end of the initial build)._

This document separates what is **complete and verified**, what is **implemented but needs credentials/vendor access to verify**, and what is a **placeholder or not built**. Each row links to the detailed workstream notes in [`docs/workstreams/`](workstreams/).

> **The one-line summary.** Every product surface works end to end in this environment with the clearly labeled **local simulator** standing in for the AI model. The real AI paths (Anthropic Claude, OpenAI) are implemented against current APIs but were **not** run with real keys — none were available. Per the brief, the core voice call must not be called "complete" until one real-provider run is done: see [First real run](#first-real-run-checklist) below. It needs one credential: `ANTHROPIC_API_KEY`.

## Legend
- ✅ **Complete**: built, and exercised end to end here (API tests + browser journeys).
- 🔑 **Needs credentials**: fully implemented against the vendor's documented API; exercised only with mocks, the simulator, or an invalid-key check. It needs the named credential for a real run.
- 🧩 **Partial / placeholder**: deliberately limited, stubbed, or not built. The reason is given.

## Verification summary (commands you can re-run)

| Gate | Result |
|---|---|
| Shared package tests (`pnpm --filter @cf/shared test`) | ✅ 67/67 |
| API tests, all suites, one run (`cd apps/api && pnpm test:prepare && npx jest --forceExit`) | ✅ 355/355 (26 suites) |
| Type checks (`pnpm -r typecheck`) | ✅ clean |
| Web production build (`pnpm --filter @cf/web build`) | ✅ 47 routes |
| Browser journeys (Playwright, `apps/web/e2e/*.spec.ts`) | ✅ 14/14 journey tests passed against a **production build** (`next build` + `next start`, CSP on) with a freshly migrated + seeded DB: 8 cross-role journeys (`journeys.spec.ts`, creator → participant → reviewer → admin → learner → knowledge → developer → every page × every role) plus each workstream's specs, against the real API. See [`QA_REPORT.md`](QA_REPORT.md) |
| Security review | ✅ 2 high / 5 medium / 6 low findings fixed. See [`SECURITY_REVIEW.md`](SECURITY_REVIEW.md) |
| Dependency audit (`pnpm audit --prod`) | ✅ no known vulnerabilities |
| Migrations from empty DB (`prisma migrate deploy`) + no drift vs schema | ✅ |
| Docker images (`infra/docker/*.Dockerfile`) | ✅ Both build. API container migrated an empty DB, booted healthy, and served signup/login through the web container |

## Feature status

### Foundation
| Capability | Status | Notes |
|---|---|---|
| Auth (signup, email verification, login, logout, password reset, change password, login-session list/revoke) | ✅ | argon2id, httpOnly SameSite cookies, Origin check, rate limits. Anything granted by email (grants, email enrollments, prior participant history) unlocks only after verification |
| Personal + organization workspaces, roles (Owner/Admin/Creator/Reviewer/Member), capability checks on every route | ✅ | 404 across workspaces |
| Invitations, members, teams, last-owner protection | ✅ | Email goes to the API log unless `SMTP_URL` is set |
| Branding (logo, colors, display name, hide "powered by") on participant pages | ✅ | |
| Audit log (sensitive actions, filters, CSV) | ✅ | |
| Schema + migrations, ScenarioVersion immutability (DB trigger), tenant-prefixed storage, signed media URLs | ✅ | |

### Scenario creator ([A](workstreams/A-scenarios.md))
| Capability | Status | Notes |
|---|---|---|
| Library, search/filters, templates (8 original), gallery (public + workspace) | ✅ | |
| Editor: guided + advanced + YAML/JSON, autosave with revision conflicts, field locks, validation panel | ✅ | YAML is parsed as data only (no tags, alias/size limits) |
| Publish (blocks on required-field / weight / placeholder errors), version history, diff, rollback-as-new-version, duplicate, export/import | ✅ | |
| Drafting assistant with per-field diff, accept/reject, locked fields respected | ✅ simulator · 🔑 real model | The real path needs `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` |
| Preview incl. compiled system prompt | ✅ | |

### Live browser session ([B](workstreams/B-runtime.md), [C](workstreams/C-live-ui.md))
| Capability | Status | Notes |
|---|---|---|
| Session state machine, explicit terminal/error states, resume with valid token only, dedupe by clientTurnId, usage charged once | ✅ | |
| Intro → consent → device check → call → end screen; captions, timer, mute/pause/end, push-to-talk, "I'm done", typed fallback, reconnect banner, tool panel | ✅ | Typed input path verified in Chromium; 360 px layout checked |
| Conversation engine: scenario intent vs live context vs state; agenda/topic tracking; follow-ups from the participant's answer; boundaries; closing exchange; timed instructions that don't cut off answers; silence check-ins that respect thinking pauses | ✅ with simulator · 🔑 with real LLM | The prompt is compiled from the version snapshot (see preview) |
| **Browser voice (Web Speech STT + speechSynthesis TTS) + Claude** | 🔑 `ANTHROPIC_API_KEY` + Chrome/Edge | Headless Chromium has no speech engine, so end-of-turn/barge-in logic was tested with a scripted recognizer |
| OpenAI Realtime (WebRTC speech-to-speech) | 🔑 `OPENAI_API_KEY` | Ephemeral client secrets are minted server-side; handshake tested against a fake peer |
| Server STT/TTS pipeline (OpenAI / Deepgram / ElevenLabs) | 🔑 respective keys | Returns 503 naming the missing key |
| Tools: end session, cards, notepad, multiple choice, document upload, knowledge search, timer, whiteboard; custom functions; audit events | ✅ | Planned tools (forms, slides, image generation, browser demo, screenshots, reactions) are registered as "coming soon" and rejected at runtime 🧩 |
| Recording (consent-gated, chunked, idempotent upload), signed playback | ✅ | Browser speechSynthesis audio can't be captured: in browser-voice mode the recording contains the participant only (disclosed in UI) |
| Local simulator | ✅ | Labeled everywhere; set `ALLOW_SIMULATOR=false` in production |

### Knowledge & tools ([G](workstreams/G-knowledge-providers.md))
| Capability | Status | Notes |
|---|---|---|
| Upload (PDF/DOCX/TXT/MD/CSV, magic-byte checks, size limits), async processing, chunking with pages/headings | ✅ | No OCR for scanned PDFs 🧩 |
| Full-text search with citations, workspace-isolated, results wrapped as untrusted data | ✅ | Semantic/vector search: interface only 🧩 |
| Provider connections (encrypted BYO keys, verify, status per capability) | ✅ Anthropic verify observed (401 on fake key) · 🔑 others | |
| Custom functions (JSON-schema args, SSRF-guarded HTTPS calls, HMAC-signed) | ✅ | |

### Post-session pipeline & review ([D](workstreams/D-analysis.md))
| Capability | Status | Notes |
|---|---|---|
| Pipeline on terminal state: finalize → score → extract → report → notify; retries, idempotent job keys, per-step visible status, reprocess | ✅ | |
| Scoring: per-criterion judgments + evidence quotes verified against transcript turns in code; weighted score computed deterministically; "insufficient evidence" instead of guesses; protected-trait text removed; human-review flag | ✅ simulator · 🔑 real model | The simulator scorer uses real transcript quotes and is labeled "Simulated analysis" |
| Extraction (text/number/boolean/list/date) with validation errors stored | ✅ | |
| Reviewer UI (report, transcript with evidence jump, recording, extracted data, processing, debug), PDF/CSV exports with permission checks | ✅ | |
| Participant report honoring visibility settings | ✅ | |

### Sharing, access, courses, coaching, analytics ([E](workstreams/E-access-admin.md), [F](workstreams/F-courses-coach-analytics.md))
| Capability | Status | Notes |
|---|---|---|
| Public / org / private scenarios; share links (multi/one-time, expiry, passcode, per-email limits, identity prompts, domains, prefilled variables); grants; revocation | ✅ | Race-safe maxUses; passcode brute-force limits |
| Embeddable widget (`embed.js`), private embed tokens (`cfe_`), origin allowlist, lifecycle events | ✅ | See `docs/embed.md` |
| Courses: ordered scenario/video/document/link items, forced order, visibility, share link, Play All, Continue / Start over, **0% for new enrollments** | ✅ | |
| Coach mode with learner-scoped memory; inspect/disable/clear | ✅ simulator · 🔑 real model for fact extraction | Memory only for verified identities |
| Analytics (counts, durations, score trends, rubric dimensions, learners, teams, scenarios, channels), CSV, role limits | ✅ | Day buckets in UTC |
| Usage ledger (tokens/minutes/chars/storage/telephony with estimated cost), quotas with hard limits, alerts | ✅ | Price table in `apps/api/src/modules/usage/pricing.ts` — review against current vendor pricing |
| Billing adapter | 🧩 | `none` adapter active; Stripe adapter is a stub (needs `stripe` package, `STRIPE_SECRET_KEY`, webhook) |
| Privacy: consent records, retention job (deletes media, redacts transcripts, keeps scores), participant data export/delete | ✅ | |

### Channels & developer platform ([H](workstreams/H-developer-channels.md))
| Capability | Status | Notes |
|---|---|---|
| API keys (scoped, hashed, revocable), REST `/api/v1` (scenarios, versions, sessions, analysis, analytics, courses, org, access tokens, usage, webhooks), cursor pagination, Idempotency-Key, rate limits, OpenAPI at `/api/docs`, `docs/api.md` | ✅ | |
| Webhooks: signed (HMAC-SHA256, timestamped), retried with backoff, auto-disable, redeliver, test ping, secret rotation | ✅ | Verified against a local receiver |
| Agent-facing tool interface (`/api/v1/agent/tools`, `/call`) — read-only tools under API-key scopes | ✅ | |
| Phone: inbound/outbound (Twilio), media-stream bridge into the same engine, batch/scheduled calls, transfer (keypad 0 / endpoint) | 🔑 Twilio account + number + public HTTPS/WSS + STT/TTS keys | Never simulated: labeled "not configured"; no real call was placed |
| Meeting bots (Recall.ai) with manual URL scheduling | 🔑 `RECALL_API_KEY` + region + public HTTPS | Calendar auto-matching not built 🧩 |

## First real run checklist
1. Put `ANTHROPIC_API_KEY=…` in `apps/api/.env` (or add it in Settings → AI providers), and optionally `ANTHROPIC_LIVE_MODEL=claude-haiku-4-5` for lower latency/cost.
2. Set a spend guard: Settings → Usage & quotas → `cost_micros` monthly hard limit (e.g. 5,000,000 = $5).
3. Open a published scenario in **Chrome or Edge** → Try it → allow the microphone → talk.
4. Afterward, check Sessions → the session → Report (scores should no longer say "Simulated").
5. Record the result in this file and flip the 🔑 rows you verified to ✅.

## Deployment
See [`DEPLOYMENT.md`](DEPLOYMENT.md): Docker images (`infra/docker/*.Dockerfile`), single-host compose with Caddy TLS (`infra/docker-compose.prod.yml`), migrations, monitoring (`/health`, logs, queues), backups/restore drill and rollback. Production deployment itself (a server, a domain, DNS) was not performed. It requires your hosting account.

## Upgrade/deploy notes
- **Email verification**: accounts are unverified until the user clicks the emailed link (needs `SMTP_URL`; without it the link is only logged in development). Don't bulk-backfill `emailVerifiedAt` — verification is what prevents someone from claiming another person's email-based access.
- **One Redis DB per environment**: every API/worker process attached to a Redis DB consumes its jobs. Never point two environments at the same Redis DB.
- Scenario variable patterns with catastrophic backtracking (e.g. nested quantifiers) are rejected by validation (ReDoS guard).

## Known limitations & recommended next steps
1. Run the first real-provider session (above), then tune prompts with real transcripts.
2. Streaming STT (Deepgram live) for the phone bridge to lower latency.
3. Stripe billing adapter; plan limits mapped to quotas.
4. OCR and semantic search for knowledge.
5. Horizontal scaling of live sessions needs sticky routing on `/ws/session` (engines are in-process).
6. External penetration test before handling real hiring decisions; keep "Require human review" on for interviews.
7. Recording finalization concatenates parts in memory (capped at 400 MB per recording); switch to S3 multipart streaming for long video sessions.
8. Minor UX: stale "Uploaded" badge on the knowledge page until refresh; a nonce-based CSP (removing `'unsafe-inline'` for scripts) via Next middleware.
9. Realtime (speech-to-speech) mode relays transcripts through the participant's browser, so its transcripts are not tamper-proof; use the pipeline mode for high-stakes assessments (see `SECURITY_REVIEW.md`).
