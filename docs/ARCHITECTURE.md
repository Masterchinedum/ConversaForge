# ConversaForge — Architecture & Engineering Contract

This document is the source of truth for how the codebase is organized and how the parts talk to each other.
Read it fully before changing code.

## Stack (all permissively licensed: MIT / Apache-2.0 / BSD / ISC)

| Layer | Choice |
|---|---|
| Web | Next.js 15 (App Router, React 19), Tailwind 3, SWR |
| API | NestJS 11 on Fastify 5, Zod validation, `@nestjs/platform-ws` WebSockets |
| DB | PostgreSQL 16 via Prisma 6 |
| Jobs | BullMQ on Redis/Valkey (worker can run in-process or as `node dist/worker.js`) |
| Storage | Local disk (dev) or any S3-compatible bucket; tenant-prefixed keys, signed URLs |
| AI | Provider adapters: Anthropic (Claude), OpenAI (LLM, Realtime voice, TTS/STT), local **simulator** |
| Shared | `packages/shared` (`@cf/shared`): scenario schema, validation, scoring math, variables, state machine, WS protocol, tool catalog |

Do NOT add GPL/AGPL/SSPL/BUSL dependencies. Check the license of anything new (`npm view <pkg> license`).

## Repository layout

```
apps/api            NestJS API + worker
  prisma/schema.prisma      full domain model (single file)
  prisma/sql/post-push.sql  raw SQL objects (immutability trigger, FTS column)
  src/config/env.ts         validated env
  src/common/*              infrastructure: prisma, redis, auth guards, errors, zod pipe, pagination,
                            crypto, audit, storage, queue, rate limit, mail, llm, domain events
  src/modules/<feature>/    one Nest module per feature (see ownership below)
apps/web            Next.js app
  src/lib/api.ts            fetch helper (`api()`, `fetcher`, `download()`, `wsUrl()`)
  src/lib/workspace.tsx     `useWorkspace()` → { workspaceId, role, can(), wsPath(), href() }
  src/components/ui         UI kit (Button, Input, Field, Card, Table, Tabs, Modal, Badge, SimulatedBadge, toasts…)
  src/app/w/[workspaceId]/  authenticated workspace area (sidebar layout)
packages/shared     @cf/shared (build with `pnpm --filter @cf/shared build` after changing it)
docs/               architecture, API, deployment, status
```

## Local development

```
service postgresql start; service redis-server start      # or: docker compose up -d
cp .env.example apps/api/.env   # fill ENCRYPTION_KEY / SIGNING_SECRET
pnpm install
pnpm --filter @cf/shared build
cd apps/api && pnpm db:sync     # prisma db push + raw SQL objects + generate
pnpm --filter @cf/api dev       # API on :4000 (tsc watch + node --watch; decorators need tsc, not tsx)
pnpm --filter @cf/web dev       # Web on :3000, proxies /api/* to the API
```

The API must be compiled with `tsc` (Nest needs `emitDecoratorMetadata`; tsx/esbuild does not emit it).
Run a one-off API: `cd apps/api && npx tsc -p tsconfig.build.json && PORT=4100 node dist/main.js`.
Run a web dev server on another port without clobbering others: `NEXT_DIST_DIR=.next-myname WEB_PORT=3100 API_INTERNAL_URL=http://localhost:4100 pnpm --filter @cf/web dev`.

### Schema changes
- `apps/api/prisma/schema.prisma` is shared. Additive changes only (new fields with defaults, new models, new indexes). Never rename/delete someone else's fields.
- Do **not** create migration files during development. Apply with `cd apps/api && pnpm db:sync`. The initial migration is generated at the end from the final schema.

## API conventions

- Global prefix `/api`. Workspace resources live under `/api/workspaces/:workspaceId/...`.
- **Auth**: global `AuthGuard` resolves the principal from cookie `cf_session`, or `Authorization: Bearer cf_live_…` (API key). Mark unauthenticated routes with `@Public()`.
- **Workspace authorization**: global `WorkspaceGuard` runs for every route with a `:workspaceId` param. It requires membership and the capability from `@RequireCapability('<cap>')` (default: `scenarios.run` = any member). Capabilities and role ranks are in `@cf/shared` `CAPABILITIES`. API keys are rejected unless the route has `@ApiScopes(...)`.
- **Every query must filter by `workspaceId`** (use `findFirst({ where: { id, workspaceId } })`, never `findUnique({ where: { id } })` alone for tenant data). A resource from another workspace is a 404.
- Validate bodies/queries with `@Body(new ZodPipe(Schema))` / `@Query(new ZodPipe(Schema))`.
- Errors: throw `Errors.notFound('Scenario')`, `Errors.forbidden()`, `Errors.validation(msg, details)`, etc. (`common/http/errors.ts`). Envelope: `{ error: { code, message, details?, requestId } }`.
- Lists use cursor pagination: `PaginationQuery`, `prismaPageArgs`, `toPage` → `{ data, nextCursor }`.
- Audit sensitive actions with `AuditService.log({ workspaceId, principal, action, targetType, targetId, metadata })`.
- Media: store under `storage.key(workspaceId, ...)`; serve via `storage.signedUrl(asset)` only after an authorization check.
- Secrets at rest: `CryptoService.encrypt/decrypt`. Bearer tokens: store `sha256` only.
- Background work: `QueueService.enqueue(QUEUES.x, name, data, { jobId: <deterministic idempotency key> })` and `queue.process(QUEUES.x, handler)` in `onModuleInit`. Handlers must be idempotent.
- Cross-module notifications: `DomainEvents` (`common/events/domain-events.ts`). Listeners must be idempotent and enqueue durable work.
- Usage/cost: `UsageService.record(...)` / `recordLlm(...)` with idempotency keys; `assertWithinQuota(workspaceId)` before starting billable work.
- LLM: `LlmService.resolve(workspaceId, purpose, preferredProvider?)` → `{ provider, model, simulated }`, then `provider.streamChat(model, req)` or `provider.completeJson(model, req)`. Always pass a `simulate` function so the local simulator can produce a deterministic, clearly-labeled result. Persist `simulated: true` on anything produced by it and show `<SimulatedBadge/>` in the UI.
- Never execute user-provided YAML/JSON/code. Parse as data, validate with Zod.

## Web conventions

- Pages under `src/app/w/[workspaceId]/...` are client components using `useWorkspace()` and SWR (`useSWR(wsPath('/scenarios'))`).
- Use the UI kit in `@/components/ui`. Keep UI simple, responsive and accessible (labels, focus, aria-live for live regions).
- Hide actions the role cannot perform with `can('<capability>')` (the API enforces it regardless).
- Participant-facing pages (no login): `/r/[token]`, `/live/[sessionId]`, `/embed/...`, `/report/[sessionId]`, `/gallery`, `/c/[courseToken]`.

## Domain invariants (must hold everywhere)

1. A `ScenarioVersion` is immutable (DB trigger blocks UPDATE). Editing changes the draft; publishing creates a new version; rollback publishes a copy of an old version as a new version.
2. A `Session` references the **exact** `scenarioVersionId` it ran with; all analysis/extraction rows carry the same `scenarioVersionId`.
3. Private resources never cross workspaces (DB queries, storage keys, signed URLs, search results).
4. A course is 0% complete for a new enrollment; progress counts only attempts in the enrollment's current `generation`.
5. Post-session processing is retryable and idempotent (deterministic job ids, upserts, unique constraints).
6. Access grants/links/tokens can expire or be revoked, and revocation is checked at use time.
7. Coach memory is scoped to (workspaceId, participantId); never mix learners.
8. Anything produced by the simulator is labeled as simulated.

## Workstream ownership

| WS | Area | API module(s) | Web routes |
|---|---|---|---|
| A | Scenarios: library, editor (guided/advanced/YAML), validation, publish/versions/rollback/duplicate, drafting assistant, templates, gallery | `modules/scenarios` | `/w/:id/scenarios/**`, `/w/:id/gallery`, `/gallery/**` |
| B | Live runtime: sessions, state machine, WS gateway, conversation engine & prompt compiler, tool registry/execution, voice provider server parts (OpenAI Realtime token, server TTS/STT), recording upload, simulator conversation | `modules/runtime` | — |
| C | Live participant UI: device check, consent, call screen, client voice adapters, tool panels, recording, reconnection; embed page + `embed.js` SDK | — | `/live/[sessionId]`, `/embed/**`, `public/embed.js`, `src/components/live/**` |
| D | Post-session pipeline: scoring, extraction, reports, PDF/CSV export, review UI, participant report | `modules/analysis` | `/w/:id/sessions/**`, `/report/[sessionId]` |
| E | Access & org admin: share links, grants, access/embed tokens, passcodes, attempt limits, public run flow; members/invites/roles/teams, branding, audit UI, usage/quotas/alerts UI, billing adapter, privacy (retention, export, delete) | `modules/access`, `modules/admin` (+ extends `workspaces`) | `/r/[token]`, `/invite/[token]`, `/w/:id/scenarios/:sid/access`, `/w/:id/settings/**` (except providers/developer), `/account` |
| F | Courses, enrollments, progress, Play All; coach profiles & learner memory; analytics & CSV | `modules/courses`, `modules/coach`, `modules/analytics` | `/w/:id/courses/**`, `/w/:id/learn`, `/w/:id/coach`, `/w/:id/analytics`, `/c/[token]`, dashboard `/w/:id` |
| G | Knowledge base (upload, async processing, FTS search with citations), provider connections (BYO keys), custom functions | `modules/knowledge`, `modules/providers` | `/w/:id/knowledge`, `/w/:id/settings/providers`, `/w/:id/settings/functions` |
| H | Developer platform: API keys, REST `/api/v1`, OpenAPI, idempotency, webhooks (signed, retried), channels (phone via Twilio, meeting bots via Recall.ai, batch/scheduled calls) | `modules/developer`, `modules/webhooks`, `modules/channels` | `/w/:id/settings/developer`, `/w/:id/channels/**`, `/docs/api` |

Shared files owned by the lead (coordinate before editing): `app.module.ts`, `main.ts`, `common/**`, `schema.prisma` (additive edits allowed), `packages/shared/**` (additive edits allowed; rebuild after), `apps/web/src/components/ui`, `apps/web/src/app/w/[workspaceId]/layout.tsx`.

## Cross-workstream contracts

### B → everyone: `SessionsService` (exported by `RuntimeModule`)
```ts
createSession(input: {
  workspaceId: string; scenarioId: string;
  versionId?: string | null;            // pinned version; default = latest published
  channel: Channel;
  participant: { userId?: string | null; email?: string | null; name?: string | null; externalId?: string | null };
  variables?: Record<string, unknown>;  // raw; resolved against the version's allowlist
  metadata?: Record<string, unknown>;
  shareLinkId?: string; accessTokenId?: string; enrollmentId?: string; courseItemAttemptId?: string;
  coachMode?: boolean;
}): Promise<{ session: Session; sessionToken: string /* "cfs_…" shown once */ }>
verifySessionToken(sessionId: string, token: string): Promise<Session>   // throws 401/404
```
Participant session REST (B), authenticated with `Authorization: Bearer cfs_…`:
- `GET  /api/runtime/sessions/:id` → bootstrap (scenario public info, consent needs, state, ClientRuntimeConfig)
- `POST /api/runtime/sessions/:id/consent` `{ recordAudio, recordVideo, analysis }`
- `POST /api/runtime/sessions/:id/realtime-token` → OpenAI Realtime ephemeral credentials (if configured)
- `POST /api/runtime/sessions/:id/recordings` → `{ assetId }`; `PUT .../recordings/:assetId/parts/:n` (binary); `POST .../recordings/:assetId/complete`
- `POST /api/runtime/sessions/:id/uploads` (document_upload tool; multipart)
- `POST /api/runtime/sessions/:id/tts` `{ text }` → audio (server TTS, if configured)
- `POST /api/runtime/sessions/:id/stt` (audio chunk → text, if configured)
- WebSocket `ws(s)://<api>/ws/session` speaking the protocol in `@cf/shared/protocol.ts`
- Member self-run (cookie auth): `POST /api/workspaces/:workspaceId/scenarios/:scenarioId/sessions`

Client token storage (C/E/F): after creating a session, store the token in `sessionStorage['cf:session:<id>']` **and** `localStorage['cf:session:<id>']` (for refresh/resume), then navigate to `/live/<id>`.

B emits `DomainEvents`: `session.started`, `session.terminal` (with final state).

### A → B: scenario versions
`ScenariosService.getRunnableVersion(workspaceId, scenarioId, versionId?)` → `{ scenario, version, config: ScenarioConfig }` (throws if unpublished/archived).

### D (analysis)
Listens to `session.terminal` → enqueues pipeline (`QUEUES.pipeline`, jobId `pipeline_<sessionId>_<kind>`). Emits `session.analyzed`, `session.extracted`, `session.failed` (on pipeline failure). Exposes `AnalysisService.reprocess(sessionId)`.

### G → B: knowledge
`KnowledgeService.search(workspaceId, documentIds, query, topK)` → `[{ chunkId, documentId, documentTitle, page, heading, text, score }]` (workspace-scoped).
`KnowledgeService.extractText(buffer, mimeType)` → `{ text, pageCount }` (used by the document_upload tool).
`CustomFunctionsService.execute(workspaceId, functionId, args, ctx)` → `{ ok, result | error }` (server-side, allowlisted hosts, timeout).

### F → B: coach memory
`MemoryService.factsForSession(workspaceId, participantId, scenarioId, limit)` → `MemoryFact[]` (empty when memory disabled for that learner).
F listens to `session.analyzed` to learn new facts (only when the version enables memory and the learner has memory enabled) and to update course item attempts (by `session.courseItemAttemptId`).

### H (webhooks)
Listens to `session.started|terminal|analyzed|extracted|failed`, writes `OutboxEvent`, fans out `WebhookDelivery` rows and delivers with HMAC-SHA256 signatures and exponential-backoff retries.

## Testing

- Shared: `pnpm --filter @cf/shared test` (vitest).
- API: jest (`*.spec.ts` next to the code). Integration specs may use a real Postgres database `conversaforge_test_<ws>` (create with `createdb`, run `DATABASE_URL=... pnpm db:sync`).
- Web: `tsc --noEmit`; browser journeys via Playwright (`apps/web/e2e`), Chromium at `/opt/pw-browsers`.
