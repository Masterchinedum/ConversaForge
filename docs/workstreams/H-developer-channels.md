# Workstream H — Developer platform, webhooks & channels

Owner areas: `apps/api/src/modules/developer`, `modules/webhooks`, `modules/channels`;
web `/w/[id]/settings/developer`, `/w/[id]/channels`, `/docs/api`; docs `docs/api.md` (full integration guide).

## What was built

### API keys (`modules/developer/api-keys.*`, capability `apikeys.manage`)
- `GET/POST /api/workspaces/:ws/api-keys`, `POST …/:id/revoke` (also `DELETE …/:id`), `GET …/api-keys/scopes`.
- Secret `cf_live_<43 chars base64url>` returned **once**; stored as `keyHash = sha256(secret)` + `prefix` (first 14 chars).
  Scopes validated against `API_KEY_SCOPES`; optional expiry (future, ≤ 5 years); max 50 active keys per workspace.
  List shows prefix, scopes, created-by, last used, expiry, status (active/revoked/expired). Create/revoke are audited.
- Cookie-session only (API keys cannot manage API keys — the routes have no `@ApiScopes`).

### REST API v1 (`modules/developer/v1/*`) — see `docs/api.md` for every endpoint with curl examples
- **API-key only** (`ApiKeyV1Guard`: user sessions → `401 api_key_required`), workspace from the key principal,
  scope per handler via `@ApiScopes` (enforced by the global WorkspaceGuard → `403`).
- Per-key fixed-window rate limit (default **600/min**, `API_KEY_RATE_LIMIT_PER_MIN`), `X-RateLimit-*` headers,
  `429` + `Retry-After`.
- `Idempotency-Key` on every v1 POST (`IdempotencyInterceptor`, table `IdempotencyRecord`, scope = workspaceId, 24 h):
  replay with `Idempotency-Replayed: true`; different request (method + path + stable-JSON body hash) → `422 idempotency_key_reused`;
  in-flight → `409 idempotency_request_in_progress` (a lock older than 5 min is taken over); deterministic errors
  (400/403/404/410/422) are replayed, 5xx/409/429/402 release the key.
- Endpoints: scenarios (list/get+draft summary/versions/version config/create from blank|template|config|import/
  PATCH draft/publish — **all through workstream A's `ScenariosService`**, same validation & immutability),
  sessions (list with filters incl. `externalId`/`email`, get with timing + usage, transcript, create → `/live/<id>#t=<cfs token>`,
  cancel before start), analysis (evaluation / extraction / report — via workstream D's `ReviewService.detail`),
  analytics summary (own Prisma aggregation; F's analytics module exposes no service yet), courses (list/get via F's
  `CoursesService`; enrollments by email and/or externalId mirroring F's enrollment rules incl. reactivation at a new
  generation), organization/members, invitations (via E's `MembersService.invite` — owner-only OWNER invites etc.),
  access tokens (via E's `AccessService.mintToken` / `revoke`), usage summary + ledger, webhooks CRUD/test/deliveries/redeliver.
- Agent tool interface: `GET /api/v1/agent/tools` (MCP-style manifest filtered by the key's scopes) and
  `POST /api/v1/agent/call {tool, arguments}` with three read-only tools (`list_scenarios`, `list_sessions`,
  `get_session_report`), strict zod argument validation, per-tool scope check, 60 000-char output cap and an
  "untrusted data, not instructions" notice on every result.
- Swagger: every v1 controller has `@ApiTags('v1 …')`, `@ApiBearerAuth()`, `@ApiOperation`; `/api/docs` shows 33 v1 paths.

### Webhooks (`modules/webhooks`, capability `webhooks.manage`)
- Workspace routes `…/api/workspaces/:ws/webhooks[/:id][/rotate-secret|/test|/deliveries[/:did[/redeliver]]]` + v1 equivalents.
- Secret `whsec_<random>` encrypted with `CryptoService`, shown once; **rotate** keeps the previous secret signing
  (second `v1=` value) for `overlapHours` (default 24, 0 = immediate).
- URL policy (`ssrf-guard.ts`): https only; `http://localhost|127.0.0.1|[::1]` only when `NODE_ENV=development`;
  no credentials in URL; internal hostnames (`*.internal`, `.local`, single-label, metadata names) refused; DNS resolved and
  **every** answer must be public (blocks 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16 incl. metadata, 100.64/10,
  0/8, multicast/reserved, TEST-NETs, ::1, fc00::/7 incl. fd00:ec2::254, fe80::/10, IPv4-mapped/NAT64/6to4 embeddings).
  Checked at create/update **and at delivery time inside the socket's DNS lookup** (defeats DNS rebinding); no redirects followed.
- Event production (`webhook-dispatcher.service.ts`): DomainEvents → `produce` job → `OutboxEvent` with a deterministic
  id `evt_<sha256(ws|session|type|variant)[:24]>` (written once) → one `WebhookDelivery` per active subscription for that
  event created before the event (unique `(subscriptionId, eventId)`) → `deliver` job `wh_<deliveryId>_<attempt>`.
  Mapping: `session.started`; `session.terminal` COMPLETED → `session.completed`, **ABANDONED → `session.completed` with
  `state: "ABANDONED"`** (the partial conversation is analysed, integrators want the end signal), FAILED → `session.failed`
  (`failure.stage="session"`), CANCELLED/EXPIRED → no event; `session.analyzed` (variant = evaluationId, so a re-analysis
  is a new event), `session.extracted` (variant = analysis generation), `session.failed` from D (`stage="analysis"`).
  Payload `{ id, type, createdAt, workspaceId, data: { session{…participant, versionNumber, metadata}, evaluation?, extraction?, failure? } }`.
- Delivery: POST JSON, `User-Agent: ConversaForge-Webhooks/1.0`, `X-ConversaForge-Event`, `-Delivery`, `-Attempt`,
  `X-ConversaForge-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`; 10 s timeout; 2xx = success.
  Retries +1m, +5m, +30m, +2h, +6h, +12h, +12h (+≤10 % jitter), 8 attempts, then FAILED. Attempts are claimed atomically
  (`attempts = n-1 → n`), each attempt is logged in the new `WebhookDeliveryAttempt` table (status, error, response snippet, duration).
  After `WEBHOOK_DISABLE_AFTER_FAILURES` (default 5) consecutive FAILED deliveries the subscription is disabled,
  audited, and OWNER/ADMIN members get a `Notification` (`webhook.disabled`). Manual redeliver / test ping = one manual
  attempt (never retried, never counted for auto-disable; a success resets the counter).
  A repeatable sweeper job (every 5 min) re-enqueues stale PENDING/RETRYING deliveries and un-dispatched outbox events.
- `verifySignature(secret, header, body, toleranceSec)` helper in `webhook-signature.ts` (+ Node and Python receiver examples in `docs/api.md`).

### Channels (`modules/channels`, capability `channels.manage`) — real adapters, never simulated
- Availability (`GET …/channels/availability`): Twilio (workspace connection JSON `{accountSid, authToken}` or env
  `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`), Recall.ai (connection or `RECALL_API_KEY` + region), server speech
  (STT: Deepgram/OpenAI, TTS: ElevenLabs/OpenAI) and whether `API_PUBLIC_URL` is a public https URL. Each missing piece
  is reported with the exact variable names.
- Phone numbers CRUD (E.164, unique per provider → one owning workspace, inbound scenario, label) + the Twilio webhook URLs to configure.
- `POST /api/channels/twilio/voice` (@Public, rate-limited): number → workspace → **X-Twilio-Signature validated**
  (HMAC-SHA1 over the full public URL + sorted POST params, with/without default port, AccountSid must match) → scenario
  must be published with `channels.phone.enabled` → `SessionsService.createSession({channel:'PHONE_INBOUND', participant:{externalId: <caller>, name:'Caller …1234'}, consent: phone greeting})`
  → TwiML `<Say>` disclosure + `<Connect><Stream url="wss://<API host>/ws/twilio"><Parameter name="sessionId"/><Parameter name="token"/>`.
  If speech providers or a public URL are missing: `<Say>Sorry, this line is not configured. Goodbye.</Say><Hangup/>` and the
  session is FAILED with `errorCode: provider_unavailable` (through B's `SessionEngine.fail`). Invalid/unsigned requests → 403.
- Media bridge (`twilio/twilio-media.gateway.ts` + `phone-bridge.ts`, WebSocket `/ws/twilio`): authenticates with the
  cfs token via B's `RuntimeService.attach(sessionId, token, EngineTransport)`; CallSid must match `Session.externalRef`.
  Caller μ-law 8 kHz → PCM → energy VAD (end-of-turn = scenario `endOfTurnSilenceMs`, clamped 0.5–3 s) → WAV → B's
  `SpeechService.stt` (Deepgram/OpenAI) → `participant.final` (source `server_stt`); agent `agent.delta/end` → sentence
  chunks → B's `SpeechService.tts` (ElevenLabs `ulaw_8000` directly, OpenAI `pcm` 24 kHz → 8 kHz → μ-law) → 20 ms `media`
  frames → `mark` per turn → `agent.playback completed`; barge-in (caller speech while audio is playing) → `clear` +
  `agent.playback interrupted` with spoken-chars estimate. STT seconds and TTS characters are recorded in the usage ledger.
  Caller hang-up → detach + `closeSession('caller_hung_up')`; agent end → stream closed after the last mark → call ends.
- `POST /api/channels/twilio/status` (signed): session events, TELEPHONY_SECONDS usage (idempotent per CallSid),
  never-connected calls → CANCELLED (`call_no_answer` etc.), outcome listeners (batches).
- Outbound: `POST /api/workspaces/:ws/channels/calls {to, scenarioId, fromNumberId?, name?, email?, externalId?, variables}`
  → session (PHONE_OUTBOUND) → Twilio `Calls.json` (Basic auth, Url = TwiML endpoint, StatusCallback + events) ; the cfs token
  is kept encrypted in Redis (24 h) for the answer-time TwiML. Twilio errors fail the session (`provider_error`).
- Transfer: `transfer_call` is **not** a runtime tool — B's ToolRegistry has no channel-specific tool hook. Implemented as
  (a) caller presses **0** (Twilio DTMF) when `channels.phone.transferNumber` is set, (b) admin `POST …/channels/calls/:sessionId/transfer`.
  Redirects the live call with `<Dial><Number>` (E.164) or `<Dial><Sip>` (sip: URI) and completes the AI session (`endedBy: transfer`).
  Also `POST …/calls/:sessionId/hangup`.
- Batches: create (BLOCKED immediately without Twilio), CSV upload (`phone` E.164 required, `name`, `email`, `external_id`,
  allowlisted variables, optional `var_` prefix; row errors, duplicates and ignored columns reported; ≤ 5000 targets, 1 MB),
  start (→ SCHEDULED/RUNNING or **BLOCKED with the reason**), cancel. Scheduler job `batch_tick` on `QUEUES.channels`:
  atomically claims PENDING targets up to `concurrency`, dials, safety re-tick every 30 s, stuck dials (15 min) → FAILED;
  status callbacks set COMPLETED / NO_ANSWER / FAILED and trigger the next dial; batch COMPLETED when nothing is left.
- Meeting bots (Recall.ai): Zoom/Meet/Teams URL validation, scenario must enable `channels.meeting`; without Recall credentials
  or a public URL the bot is stored **BLOCKED** with the reason (no session). Otherwise a MEETING session (consent source
  `meeting_bot`) + `POST https://<region>.recall.ai/api/v1/bot/` (`Authorization: Token …`, `meeting_url`, `bot_name`,
  `join_at`, `recording_config.transcript.provider.recallai_streaming`, `realtime_endpoints: [{type:'webhook', url, events:['transcript.data']}]`, metadata).
  `POST /api/channels/recall/webhook` accepts the per-bot realtime endpoint (HMAC token in the URL) or a **Svix-signed**
  status webhook (`RECALL_WEBHOOK_SECRET`, `webhook-*`/`svix-*` headers, 5 min tolerance). Utterances become TranscriptTurns
  (deduped by a content hash; speaker = PARTICIPANT when the name matches `evaluatedSpeakerName`, else AGENT/"counterpart";
  all PARTICIPANT when unset). Status → session ACTIVE / COMPLETED (analysed by D's normal pipeline) / FAILED / CANCELLED
  (no transcript). A `recall_poll` job polls `GET /bot/{id}/` every minute so completion works even without dashboard webhooks.
  Meeting sessions are passive (no AI speaks), so their lifecycle is driven by `meeting-session.ts` (shared state machine,
  CAS updates, same DomainEvents). Calendar matching: `calendarEventId` is stored; Google Calendar auto-join is **not implemented**.

### Web
- `/w/[id]/settings/developer`: API keys (create modal with scopes checklist, expiry, one-time secret + copy, revoke),
  webhooks (create/edit with events checklist, one-time secret, send test, enable/disable, rotate secret, delete,
  deliveries log with status filter, attempts, response codes/errors, payload, redeliver), links to `/docs/api` and `/api/docs`.
- `/w/[id]/channels`: provider banners with exact reasons; tabs: phone numbers (inbound scenario select, Twilio webhook URLs),
  outbound call form, recent calls (transfer); batches (create, CSV file/paste upload with row errors, start/schedule,
  cancel, progress bar, targets table with session links); meeting bots (schedule, status list, session links, cancel).
- `/docs/api`: concise static guide (auth, conventions, endpoint table, session example, webhooks + verification
  snippets, embed flow, agent tools) linking to Swagger.

## Tests (actual results)
- `npx jest src/modules/webhooks src/modules/channels` → **2 suites, 63 tests passed**: signature generate/verify,
  tolerance both directions, multi-`v1` rotation, raw buffers; SSRF IPv4/IPv6 ranges, dev-localhost rule, DNS answers
  (incl. mixed private); retry schedule + auto-disable decisions; event mapping; Twilio signature with the documented
  values (`RSOYDt4T1cUTdK1PDd93/VVr8B8=`, port variant `kvajT1Ptam85bY51eRf/AJRuM3w=`); TwiML output/escaping; E.164;
  CSV parsing (quotes/CRLF/BOM, invalid rows, dedupe, allowlist); μ-law, resampling, WAV, VAD; PhoneBridge with fake
  engine/STT/TTS (media+mark, barge-in clear, STT→participant.final, TTS failure w/o stall, no unhandled rejection,
  hang-up); Svix verification, meeting URL validation, Recall parsing.
- `H_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/conversaforge_test_h npx jest src/modules/developer/h.integration.spec.ts --forceExit`
  → **13 tests passed** (full AppModule over Fastify inject, real Postgres, queue replaced by a recorder): key storage,
  missing scope 403, revoked/expired 401, cookie on v1 401, cross-workspace 404s (incl. foreign cursor 400), create
  session URL + cancel, pagination, idempotency replay/mismatch/in-flight/error replay, 429 + Retry-After, agent tools,
  webhook outbox-once + signed delivery + retry job ids/delays + 8 attempts → FAILED → auto-disable + notification +
  redeliver + delivery-time SSRF block, event filtering, provider-missing paths (403 unsigned, 503 outbound, BLOCKED batch,
  spoken "not configured" + FAILED/provider_unavailable session, BLOCKED meeting bot), Recall happy path with faked HTTP
  (bot request body, transcript ingestion + dedupe, Svix status → COMPLETED), batch scheduler concurrency/outcomes/completion.
  (`--forceExit` because other modules keep timers open after `app.close()`.)
- Manual exercise on API :4108 / web :3108 (all real HTTP):
  - curl: API key → v1 org/scenarios (template create, publish), sessions (create/list/get/transcript/cancel), analysis 404s,
    analytics, usage, courses, members, invitations (OWNER refused), access token mint, agent tools; idempotent replay header seen.
  - Local receiver on :4188 (verifies signatures): ping delivered (valid signature); `session.started` with the receiver
    failing twice → attempts at +0, +65 s, +5 m 10 s, succeeded on attempt 3 (all signatures valid).
  - Full live session through B's `/ws/session` (simulator LLM, typed turns) → receiver got `session.started`,
    `session.completed`, `session.analyzed` (evaluation labeled `simulated: true`), `session.extracted` (3 values), all signed.
  - Twilio: signed inbound webhooks (valid → TwiML; bad/other token → 403; unknown number → spoken message); with
    speech keys missing → session FAILED `provider_unavailable`. With fake Deepgram/ElevenLabs keys and a public-looking
    `API_PUBLIC_URL`, a simulated Twilio media stream client bridged to the engine (session ACTIVE → COMPLETED on `stop`);
    the real Deepgram/ElevenLabs endpoints were called and returned 403 (fake keys) — handled without stalling or crashing.
    Status callback recorded 37 TELEPHONY_SECONDS once (idempotent on repeat).
  - Batch: CSV with invalid rows → 2 added, errors listed, ignored column reported; start → BLOCKED with the speech reason.
  - Playwright (Chromium) against :3108: created an API key (one-time secret), created a webhook to :4188, "Send test" →
    "Ping delivered (HTTP 200)", deliveries modal with attempt log/payload; channels page banners, add phone number,
    meeting tab BLOCKED warning, batches tab; `/docs/api` renders.

## Not verified / externally blocked (exact requirements for real runs)
Nothing in channels is simulated; these paths are implemented against the providers' documented APIs but could not be
run end-to-end here (no credentials, no public ingress):
- **Phone (Twilio)**: a Twilio account (Account SID + Auth Token → `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` or a Twilio
  connection in Settings → AI providers), at least one voice-capable Twilio phone number added under Channels with its
  *A call comes in* webhook = `https://<API_PUBLIC_URL>/api/channels/twilio/voice` (POST) and *Call status changes* =
  `…/api/channels/twilio/status`; `API_PUBLIC_URL` must be a public **https** URL whose host also serves **wss://…/ws/twilio**
  (TLS-terminating proxy that passes WebSocket upgrades, sticky to one API instance — engines live in memory); server
  speech keys: STT `DEEPGRAM_API_KEY` or `OPENAI_API_KEY`, TTS `ELEVENLABS_API_KEY` or `OPENAI_API_KEY`; an LLM key
  (`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`) unless the labeled simulator is acceptable. Outbound calls to unverified numbers
  need an upgraded (non-trial) Twilio account; some countries need Twilio geo permissions. Transfers need
  `channels.phone.transferNumber` (E.164 or `sip:` URI; SIP needs a SIP domain/PBX reachable by Twilio).
- **Meeting bots (Recall.ai)**: a Recall.ai API key (`RECALL_API_KEY`) and its region (`RECALL_REGION`: us-east-1,
  us-west-2, eu-central-1 or ap-northeast-1), public https `API_PUBLIC_URL` for the realtime transcript webhook, and
  optionally the workspace verification secret `RECALL_WEBHOOK_SECRET` (whsec_…) with a dashboard webhook to
  `…/api/channels/recall/webhook` for faster status updates (polling works without it). Zoom may require the bot to be
  admitted / recording permission granted by the host. The exact Recall request/response shapes were taken from Recall's
  public docs (docs site not reachable from this sandbox; verified via search excerpts) — re-check `recording_config`
  field names against the current API version before production.
- **Latency/voice quality** of the phone bridge (energy VAD + batch STT per utterance) is untested with real audio;
  a streaming STT (Deepgram live) would lower latency and is the recommended next step.
- Google Calendar auto-join for bots: not implemented (`calendarEventId` is stored only; needs a `google_calendar` OAuth connection).

## Contract / shared-file changes (all additive)
- `schema.prisma`: `WebhookSubscription.previousEncryptedSecret/previousSecretExpiresAt/disabledReason`;
  `WebhookDelivery.attemptLog` relation + `@@index([status, nextAttemptAt])`; new model `WebhookDeliveryAttempt`;
  `OutboundCallBatch.statusReason/variables/startedAt/completedAt`; `OutboundCallTarget.callSid/externalId`;
  `MeetingBot.botName/evaluatedSpeakerName/lastEventAt`; `Session @@index([externalRef])`.
- `config/env.ts` + `.env.example`: `RECALL_WEBHOOK_SECRET`, `API_KEY_RATE_LIMIT_PER_MIN` (600), `WEBHOOK_DISABLE_AFTER_FAILURES` (5).
- Uses (no changes to) B `SessionsService`, `RuntimeService.attach`, `SessionEngine.fail/closeSession`, `SpeechService`;
  A `ScenariosService`; D `ReviewService`; E `AccessService`, `MembersService`; F `CoursesService` + `participants.ts` helpers.
- For B: phone sessions are created with prefilled consent (`source: phone_greeting` / `meeting_bot`), `externalRef` = Twilio
  CallSid or Recall bot id. The phone transport kind is `'phone'`; it sends `participant.final` with `source: 'server_stt'`,
  `agent.playback` started/completed/interrupted and `participant.speaking`. A runtime hook for channel tools (e.g. an
  agent-initiated `transfer_call`) would let the agent trigger `PhoneService.transferCall` directly.
- For D/F: MEETING sessions have AGENT turns that are the *counterpart* speakers (metadata `role: 'counterpart'`, `speakerName`).

## Files
API: `modules/developer/{developer.module.ts, api-keys.service.ts, api-keys.controller.ts, h.integration.spec.ts}`,
`modules/developer/v1/{v1.common.ts, idempotency.interceptor.ts, v1-scenarios.controller.ts, v1-sessions.controller.ts, v1-org.controller.ts, v1-tokens-webhooks.controller.ts, v1-agent.controller.ts}`,
`modules/webhooks/{webhooks.module.ts, webhooks.controller.ts, webhooks.service.ts, webhook-dispatcher.service.ts, webhook-signature.ts, webhook-retry.ts, webhook-payload.ts, webhook-http.ts, ssrf-guard.ts, webhooks.unit.spec.ts}`,
`modules/channels/{channels.module.ts, channels.controller.ts, channel-providers.service.ts, phone.service.ts, phone-numbers.service.ts, batches.service.ts, meetings.service.ts, meeting-session.ts, csv.ts, channels.unit.spec.ts, audio/audio.ts, recall/recall.ts, twilio/{twilio-signature.ts, twiml.ts, phone-bridge.ts, twilio-media.gateway.ts}}`;
shared edits: `prisma/schema.prisma`, `src/config/env.ts`, `/.env.example`.
Web: `app/w/[workspaceId]/settings/developer/{page.tsx, api-keys.tsx, webhooks.tsx}`, `app/w/[workspaceId]/channels/page.tsx`, `app/docs/api/page.tsx`.
Docs: `docs/api.md`, this file.
