# Workstream F — Courses, coach mode & analytics

Owner areas: `apps/api/src/modules/{courses,coach,analytics}`, web routes `/w/[id]` (dashboard),
`/w/[id]/courses/**`, `/w/[id]/learn/**`, `/w/[id]/coach`, `/w/[id]/analytics`, `/c/[token]`,
components `apps/web/src/components/{learning,analytics}`, `apps/web/src/lib/learning.ts`.

## What was built

### Courses (API `modules/courses`)

| Method & path (prefix `/api/workspaces/:ws`) | Capability | Purpose |
|---|---|---|
| `GET /courses?status&q` | `sessions.review` | List with item / learner / completed counts |
| `POST /courses` | `courses.edit` | Create (title, description, coverUrl, forcedOrder, visibility) |
| `GET /courses/:id` | `sessions.review` | Course + items (scenario/asset info, parsed completion rule) |
| `PATCH /courses/:id` | `courses.edit` | Details, `coverUrl` (https), forcedOrder, visibility, status DRAFT/PUBLISHED/ARCHIVED (publish validates ≥1 item and runnable scenarios) |
| `DELETE /courses/:id` | `courses.edit` | Soft delete (share token cleared) — audited |
| `POST /courses/:id/assets?purpose=cover\|video\|document` | `courses.edit` | Multipart upload → `MediaAsset(COURSE_ASSET)` under `ws/<ws>/courses/<id>/…`; type decided by magic bytes (PNG/JPEG/GIF/WebP, MP4/WebM/MOV, PDF), size caps 10/200/50 MB. `cover` also sets the course cover |
| `DELETE /courses/:id/cover` | `courses.edit` | Remove cover (asset retired if unused) |
| `POST /courses/:id/share-token` / `DELETE …` | `courses.assign` | Generate/rotate, revoke the `/c/<token>` link — audited |
| `POST /courses/:id/items`, `PATCH/DELETE /courses/:id/items/:itemId` | `courses.edit` | Items: SCENARIO (same-workspace scenario with a published version, optional `pinnedVersionId` of that scenario), VIDEO/DOCUMENT (own `COURSE_ASSET` of the right type **or** public https URL), LINK (https). Rule per kind: scenario → `session_completed` (default) / `min_score` / `manual`; content → `viewed` (default) / `manual`. `required` flag |
| `PUT /courses/:id/items/order` `{itemIds}` | `courses.edit` | Reorder in one transaction (course row locked `FOR UPDATE`; positions stay contiguous 0..n-1, also after deletes) |
| `GET /courses/options/scenarios` | `courses.edit` | Published scenarios + versions for the item picker |
| `GET /courses/options/assignees` | `courses.assign` | Members and teams for the assign dialog |
| `GET /courses/:id/enrollments[?includeDropped=true]` | `sessions.review` | Progress by learner |
| `POST /courses/:id/enrollments` `{userIds, teamIds, emails, notify}` | `courses.assign` | Assign members / teams (expanded to their participants) / emails (creates an email-only Participant; links to an existing account with that email). Optional email notice (published courses). Audited |
| `GET /courses/:id/enrollments/:eid` | `sessions.review` | Per-item status + full attempt history (all generations) |
| `DELETE /courses/:id/enrollments/:eid` | `courses.assign` | Unenroll (status DROPPED, history kept) — audited |
| `POST /courses/:id/enrollments/:eid/items/:itemId/complete` | `sessions.review` | Reviewer sign-off for `manual` items — audited |

Learner endpoints (any member, own data only):

| `…/learn` | overview: my enrollments with progress & next item, available ORGANIZATION/PUBLIC courses |
|---|---|
| `GET …/learn/courses/:courseId` | player detail: items with status/locks for the **current generation**, next item, history of earlier generations, `canEnroll/canUnenroll` |
| `POST/DELETE …/learn/courses/:courseId/enroll` | self-enroll (ORGANIZATION/PUBLIC published courses; creators may preview drafts) / leave (only self-enrolled) |
| `POST …/learn/courses/:courseId/items/:itemId/start` | creates `CourseItemAttempt` (generation = enrollment.generation) and, for scenarios, calls `SessionsService.createSession({ enrollmentId, courseItemAttemptId, … })` → `{ sessionId, sessionToken, liveUrl }`; for content returns `{ content }` (signed URL). Forced order → **409** `item_locked` |
| `POST …/items/:itemId/complete` | marks a `viewed` item complete (idempotent) |
| `GET …/items/:itemId/content` | signed URL (30 min) / external URL, after lock + enrollment checks |
| `POST …/learn/courses/:courseId/continue` | starts (scenario) or returns (content) the first incomplete item |
| `POST …/learn/courses/:courseId/start-over` | `generation++`, status ACTIVE; old attempts kept, no longer counted |

Course share link `/api/c/:token` (every call re-resolves the token, so rotate/revoke is immediate):
`GET /c/:token` (public, rate-limited 120/min/IP: outline, org name, viewer status), and for any
signed-in user `POST /c/:token/enroll`, `GET /c/:token/player`, `POST /c/:token/items/:itemId/start|complete`,
`GET /c/:token/items/:itemId/content`, `POST /c/:token/continue|start-over` (starts rate-limited per user).
Non-members never become workspace members through a course link.

**Progress rules** (`course-rules.ts`, pure & unit-tested): progress = completed required items of the
enrollment's current `generation` ÷ required items (all items if none is required). Attempts are only ever
created through the course player, so prior sessions, the course creator's activity, etc. can never count.
A new enrollment — and a re-enrollment after being dropped — starts a fresh generation at **0%**.
No "credit prior work" option was implemented.

**Completion** (`course-progress.service.ts`): listens to `session.terminal`, `session.analyzed` and
`session.failed`, enqueues `QUEUES.courses` (`course-progress`) jobs (inline fallback if Redis is down) and
recomputes the attempt from source rows (session state + current evaluation), so duplicates/out-of-order
events are harmless. It verifies the attempt belongs to that session (and workspace). Rules:
`session_completed` → COMPLETED iff state COMPLETED; ABANDONED/FAILED/… → FAILED (retry allowed);
`min_score` → waits ("Waiting for scoring…"), then COMPLETED only if `overallScore ≥ minScore`;
insufficient evidence / null score / low score → FAILED with a visible reason; analysis disabled/declined →
FAILED with reason. A COMPLETED attempt is never downgraded; a FAILED one can become COMPLETED after
re-analysis. Enrollment → COMPLETED (+completedAt) once all required items complete (idempotent
`updateMany … status: ACTIVE`). Safety net: opening the player reconciles STARTED attempts whose session
already ended (lost events).
Score privacy: learners only get numeric scores (attempt score, min-score reason text) when the scenario
version lets participants see scores (`analysis.participantCanSeeScores` + `rubric.visibility =
participant_and_reviewers` + human review done) — same rule as D's participant report.

### Coach memory (API `modules/coach`)

`MemoryService` (exported; B finds it at `../coach/memory.service`):
- `factsForSession(workspaceId, participantId, scenarioId, limit)` → active facts (not disabled/deleted),
  ranked same-scenario first, then goal > weakness > strength/preference > context > progress, then recency;
  `[]` when the learner's `memoryEnabled` is false. Every query filters by **both** workspaceId and
  participantId (and the profile id).
- `profileForSession(workspaceId, participantId)` → `{ goals, summary }` or null when memory is off (optional extra for B).
- Learning: on `session.analyzed` / `session.failed`, or `session.terminal` when analysis will not run, a
  `QUEUES.memory` (`coach-memory`) job runs `learnFromSession`: only if the version has
  `memory.enabled && memory.learnFromSessions`, the learner's memory is on and the state is
  COMPLETED/ABANDONED. Idempotent per session (ProcessingJob lock `memory_learn:<sessionId>` with stale
  takeover + source-session check). Real provider: `LlmService.resolve(ws,'memory')` + `completeJson` with a
  JSON schema; the transcript is sent between `<<<TRANSCRIPT … TRANSCRIPT>>>` markers as untrusted data;
  output is post-filtered (≤5 facts, ≤280 chars, category whitelist, regex filter for health/religion/
  sexuality/ethnicity/politics/union/criminal/immigration/financial/credential data, near-duplicate removal
  against existing facts); usage recorded via `UsageService.recordLlm`. Simulator: deterministic
  `[Simulated] Practiced "<scenario>" on <date>` plus strongest/weakest scored criterion, all
  `category: progress`, `simulated: true`, `metadata.source = 'simulator'`.

Endpoints (`/api/workspaces/:ws/coach`): self — `GET/PATCH me` (memoryEnabled, goals),
`PATCH me/facts/:id {disabled}`, `DELETE me/facts/:id`, `DELETE me/facts`; reviewers (`memory.manage`) —
`GET learners?q&cursor`, `GET/PATCH learners/:participantId`, `PATCH/DELETE learners/:pid/facts/:id`,
`DELETE learners/:pid/facts`. Reviewer actions are audited (`memory.fact_disabled|enabled|deleted`,
`memory.cleared`, `memory.settings_updated`; fact text is never written to the audit log). Deletes are hard
deletes (the learner asked to forget).

### Analytics (API `modules/analytics`)

- `GET /api/workspaces/:ws/analytics/summary?from&to&scenarioId&teamId&channel&participantId&top`
  (any member; API keys with `analytics:read`). Members without `analytics.view` get **their own sessions
  only** (forced filter on `Participant.userId`), no cost, and only scores the scenario lets participants see.
  Returns KPIs (sessions, completed, completion rate among ended sessions, total/avg duration, avg score over
  scored sessions — insufficient evidence excluded and counted separately, learners, simulated share, cost =
  Σ `UsageLedger.costMicros` for the period, or for the filtered sessions when filters narrow them),
  sessions by state, daily UTC buckets (sessions/completed/avg score, continuous axis), rubric dimension
  averages (grouped by criterion id, latest name; only with `scenarioId`), breakdowns by scenario, top-N
  learners, team, channel, 10 most recent sessions, filter options. All SQL via `$queryRaw` tagged templates
  / `Prisma.sql` fragments — no string concatenation of input. Default range: last 30 days; `to` as a plain
  date is inclusive; max 366 days.
- `GET …/analytics/export.csv` (`exports.download`): same filters, one row per session (date, id, scenario,
  version, participant, email, teams, channel, state, duration, overall score, insufficient evidence, one
  column per criterion (packed into one column above 40 distinct criteria), simulated). Formula-injection
  escaping (`'` prefix for cells starting with `= + - @ \t \r`), RFC-4180 quoting, UTF-8 BOM. Audited
  (`analytics.exported`).

### Web

- `/w/[id]` dashboard: reviewers+ → 30-day KPIs, sessions/score trend charts, recent sessions, shortcuts;
  learners → next step, course progress cards (honest 0%), own practice stats & recent sessions.
- `/w/[id]/analytics`: period presets/custom range, scenario/team/channel filters, KPI cards, inline-SVG
  line charts (sessions/day, avg score/day — two charts, no dual axis) with hover crosshair+tooltip, rubric
  bar chart, breakdown bars + tables, state badges, recent sessions, CSV export button. Simulated-share banner.
- `/w/[id]/courses`, `/w/[id]/courses/[courseId]`: list/create; editor with Items (add/edit modal per kind,
  upload or URL, version pin, completion rule, required, ↑/↓ reorder, remove), Details (title, description,
  forced order, cover upload/URL, archive/delete), Access & sharing (visibility, link copy/rotate/revoke),
  Learners (assign members/teams/emails, progress table, per-learner attempt detail incl. earlier
  generations, reviewer "Mark complete" for manual items, unenroll).
- `/w/[id]/learn`: my courses (progress bars, Continue / Play all / Start over with confirm), available
  courses, shared scenarios from E's `GET /api/me/shared-scenarios` (404 → hidden gracefully; "Start
  practice" uses E's `POST /api/shared/scenarios/:id/sessions`), recent sessions from D's
  `GET /api/me/sessions` with report links.
- `/w/[id]/learn/courses/[courseId]` and `/c/[token]` share `CoursePlayer`: item list with status/locks/
  reasons, Start/Try again/Resume, video player / PDF viewer (signed URLs made same-origin through the web
  proxy) / link viewer with "Mark as viewed", **Play All** (`?playAll=1` survives the `/live/<id>?return=`
  round trip; auto-starts the next incomplete item, waits/polls while a min-score item is being scored,
  pauses instead of looping when an attempt failed or was left unfinished).
- `/w/[id]/learn/memory` (learner's own memory) and `/w/[id]/coach` (reviewer learners list with memory
  counts + inspect/disable/delete/clear/toggle/goals) share `MemoryPanel`.
- `/c/[token]`: outline for anyone; sign-in/sign-up with `next`; members are enrolled then sent to their
  workspace player; non-members take the course on the page itself.

## Schema / shared changes (additive)

- `MemoryFact.simulated Boolean @default(false)`, `MemoryFact.metadata Json @default("{}")`, index on `sourceSessionId`.
- `CourseItemAttempt.statusReason String?`, `CourseItemAttempt.evaluationId String?`.
- `Enrollment @@index([userId])`.
- `QUEUES.courses = 'course-progress'`, `QUEUES.memory = 'coach-memory'` in `common/queue/queue.service.ts`
  (own queues so no other module's worker consumes these jobs).

## How it was tested (actual results)

- `npx jest src/modules/courses src/modules/coach src/modules/analytics` → **4 suites, 44 tests passed**
  against Postgres `conversaforge_test_f` (real `SessionsService` from B for course sessions):
  - `course-rules.spec.ts` (16): 0% without attempts, generation scoping, optional items, forced-order
    locks, status derivation, min_score incl. insufficient evidence & hidden numbers, rule defaults, https-only URLs.
  - `courses.int.spec.ts` (11): **new enrollment is 0% although the learner and the creator already
    completed the same scenario**; journey start → session COMPLETED → 50% → video viewed → 100% +
    enrollment COMPLETED; duplicate/replayed events idempotent (completedAt unchanged); **start over** →
    generation 2, 0%, history kept, late old-generation events ignored; abandoned → FAILED → retry;
    **forced order 409**; **min_score** waiting → insufficient evidence (FAILED) → 65 < 70 (FAILED) →
    re-analysis 75 (COMPLETED) → later 10 does not downgrade; foreign-workspace session claiming an attempt is
    ignored; private vs organization visibility; share token works for outsiders and dies on rotate/revoke;
    email assignment claimed after signup; team expansion; item validation & contiguous positions; cross-workspace 404.
  - `memory.int.spec.ts` (10): **learner A's facts never returned for B nor across workspaces**
    (controls scoped too); **memory disabled → `factsForSession` = []**; disabled/deleted hidden, limit;
    simulator learning deterministic, labeled and idempotent; scenario/learner opt-outs; LLM path sends the
    transcript as delimited data and drops sensitive + duplicate facts.
  - `analytics.int.spec.ts` (7): KPIs incl. insufficient-evidence exclusion, daily buckets, breakdowns,
    rubric dimensions, cost; scenario/team/channel filters; injection string matches nothing; other
    workspace's team id leaks nothing; **members see only their own data** (and no cost) whatever filters
    they pass; learners don't see scores the scenario hides; CSV header/rows/escaping.
- Real API run (port 4106) with curl: creator created a course, added a scenario item, uploaded an MP4
  (a fake "PDF" was rejected by magic bytes), rejected `http://` link, member got 403 on editing,
  published with forced order, assigned learner + an email; learner saw 0%, got 409 on the locked video,
  started the scenario, a WebSocket driver completed the (simulated) session through B's runtime →
  **50%**, signed video URL served (tampered URL 403), viewed → **100% / COMPLETED**, reviewer table showed
  100% and the invited email at 0%, start over → 0% with history, continue → new session. A session of the
  memory-enabled "Active listening coaching" template produced a `[Simulated]` progress fact via
  `session.analyzed`. Analytics: reviewer workspace scope, learner `own` scope (no cost), learner CSV → 403,
  reviewer CSV download, invalid channel/date → 422.
- Playwright (Chromium, web on 3106): creator builds a course in the UI (scenario + link items, forced
  order, publish, course link, assign learner) → learner sees 0%, clicks **Play all** → redirected to
  `/live/<id>?return=/w/<ws>/learn/courses/<id>?playAll=1` → session completed → back on the course page
  Play All automatically opened the next (link) item → "Mark as viewed & continue" → 100% → Start over → 0%
  with "Earlier attempts"; learner dashboard/memory, reviewer analytics (incl. scenario rubric view),
  dashboard and coach pages; signed-out `/c/<token>` shows sign-in; a **non-member** enrolled through
  `/c/<token>`, started the scenario (return to `/c/<token>`), completed it → 50%, and got 404 on the
  workspace API.

## Not done / limitations

- Real-provider memory extraction (Anthropic/OpenAI through `completeJson`) is implemented against the
  common LLM adapters but **not exercised with a real key** (none available); tested with a fake provider
  and the simulator.
- No "credit sessions completed before enrollment" option (by design; would have to be an explicit,
  default-off course setting).
- PUBLIC courses are discoverable by non-members only via their share link (no public course gallery).
- Email-assigned enrollments are claimed by the account with the same email (same trust model as B's
  participant linking, which does not require a verified email).
- Removing a course item deletes its attempts (cascade); reordering/adding items to a completed course does
  not reopen the enrollment's COMPLETED status (progress % is always computed live).
- Analytics day buckets are UTC.

## Notes for other workstreams

- **B**: course sessions are created with `enrollmentId`, `courseItemAttemptId`, `coachMode: true`,
  `metadata.courseId/courseItemId`, participant `{ userId, email, name }`. My participant resolution
  (`courses/participants.ts`) mirrors `upsertParticipant` (oldest participant for `(workspaceId,userId)`,
  else unclaimed same-email participant) so enrollment and session share a participant — keep them in sync.
  `MemoryService.factsForSession` + optional `profileForSession` at `modules/coach/memory.service.ts`.
- **D**: I rely on `session.analyzed` / `session.failed` and `Evaluation.isCurrent/status/overallScore/
  insufficientEvidence/humanReviewRequired/reviewedAt`. The player links to `/report/<sessionId>`.
- **H**: `v1-org.controller.ts` uses `CoursesService.courseDto/get/findCourse` and `participants.ts`
  helpers — those signatures are stable. Note H's own `/api/v1/analytics/summary` averages do not exclude
  insufficient-evidence evaluations; `AnalyticsService.summary(ws, AnalyticsQuery, { role: 'ADMIN', userId: null })` is available to reuse.
