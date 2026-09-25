# Workstream D — Post-session pipeline, reports & review

Owner areas: `apps/api/src/modules/analysis/**`, web routes `/w/[workspaceId]/sessions/**` and `/report/[sessionId]`, and the shared review components in `apps/web/src/components/review/**`.

## What was built

### Post-session pipeline (`analysis.service.ts`, `steps.service.ts`)
The pipeline starts when `session.terminal` fires (workstream B's engine, H's v1 cancel, and meeting sessions all emit it). It runs as BullMQ jobs on `QUEUES.pipeline`:

```
finalize_transcript → score → extract → report → notify → complete (status + events)
```

- **When it runs.** Sessions that end as COMPLETED, ABANDONED or FAILED are analyzed if they have at least one participant turn. A session is marked `analysisStatus=SKIPPED`, with the reason in `analysisError`, when:
  - it ended as CANCELLED or EXPIRED,
  - `consent.analysis === false`,
  - the version sets `analysis.enabled=false`, or
  - it has no participant speech.
- **Idempotency.** Each step has a deterministic job id and `ProcessingJob.idempotencyKey`, `pipeline_<sessionId>_<step>_g<generation>`. The first start is guarded by a conditional update (generation 0 → 1), so duplicate `session.terminal` events are no-ops.
  - `Evaluation` is unique per `(sessionId, generation)`. Its criteria are deleted and recreated inside one transaction.
  - `ExtractionResult` rows are upserted per `(sessionId, key)`.
  - The report is upserted, and notify runs once per session.
  - Analysis token usage is recorded with idempotency key `analysis:<sessionId>:<step>:g<gen>`.
- **Retries.** A step gets 4 attempts with exponential backoff (5 s base).
  - These are not retried: `NonRetryableError` (bad config, or no provider when the simulator is disabled) and provider 4xx responses other than 408, 409 and 429. For example, an invalid key fails immediately.
  - A step that fails for good is marked `FAILED` with its error, and the pipeline continues with the remaining steps.
  - Final status: `COMPLETED` if nothing failed. `FAILED` if score or extract failed and neither produced a result. `PARTIAL` otherwise.
  - Earlier results are never overwritten by a failure. On reprocess, the previous evaluation stays current until the new score step succeeds.
- **Events.** On `COMPLETED` or `PARTIAL` the pipeline emits `session.analyzed` `{evaluationId, overallScore}` from the current evaluation. It also emits `session.extracted` when extract completed. On `FAILED` it emits `session.failed` with `errorCode: 'analysis_failed'`.
- **Reprocess and retry.**
  - `AnalysisService.reprocess(sessionId, workspaceId?)` starts a new generation. History is kept: older evaluations get `isCurrent=false`, and jobs from a superseded generation mark themselves SKIPPED.
  - `retryStep(workspaceId, sessionId, step)` re-queues a FAILED step and every step after it. It replaces the finished BullMQ jobs that have the same ids.
- **Sweep.** Every worker process runs a sweep 5 s after start, then every 10 min through the `pipeline-sweep` BullMQ job scheduler on the same queue.
  - It re-enqueues sessions stuck in QUEUED/PROCESSING. A step that is still waiting or active is left alone.
  - It starts sessions whose terminal event was missed: analyzable state, generation 0, older than 2 min.

### Scoring (`prompts.ts`, `scoring.ts`, `evidence.ts`)
- The rubric comes from the session's **exact** `scenarioVersionId`.
- The model is resolved with `LlmService.resolve(ws, 'analysis', config.model.llmProvider)` and called through `completeJson` with a strict JSON schema: per-criterion `score|null`, `insufficientEvidence`, `confidence`, `rationale` and `evidence[{turnSeq, quote}]`, plus `summary`, `strengths`, `weaknesses`, `improvements` and `notes[{text, turnSeqs}]`.
- **The prompt:**
  - renders the transcript as `[seq] SPEAKER:` lines inside `<transcript>` tags and marks it as data,
  - tells the model to ignore instructions found inside the transcript,
  - requires verbatim quotes, and null plus `insufficientEvidence` when evidence is missing,
  - forbids considering or mentioning protected traits.
- **Checks in code:**
  - Every quote must appear in the turn it cites. Matching is normalized and fuzzy: exact token match, or a token-LCS window of at least 85% for quotes of 4 or more tokens, so filler words can differ. Ellipsis fragments must appear in order.
  - The cited turn's speaker must match the evaluated subject. `subjectSpeaker()` maps the rubric's evaluatedSubject text to PARTICIPANT by default, AGENT, or "either".
  - A score with no surviving evidence becomes `insufficientEvidence` with a null score.
  - Sentences in model text that mention protected traits are removed (`redactProtected`) as a safety net.
  - The overall score is computed only by `computeWeightedScore` from `@cf/shared`, using the rubric's weights, `minEvidenceCoverage` and `passingScore`.
- **Stored with each `Evaluation`:** `scenarioVersionId`, `rubricHash` (sha256 of the stable-stringified rubric), provider, model, `promptVersion` (`score-v1`) and `simulated`.
- `humanReviewRequired` is set when the version sets `analysis.requireHumanReview` or the scenario type is `interview`.

### Extraction
- The JSON schema is built from `config.extraction.variables`. Each variable is `{value: <type>|null, evidenceTurnSeqs, confidence}`, with enums for text and list types.
- Each value is coerced with `validateExtractionValue`. Invalid values are stored with `valid=false` and `errors`.
- Evidence turn numbers are filtered to real turns, and a short excerpt is stored for each.

### Simulator (`simulator.ts`)
Used when no provider is configured. It is deterministic and quotes only real text.
- **Scoring.** Participant turns are matched to each criterion by keyword-stem overlap with its name, description and strong-performance text. The score comes from that overlap plus specificity signals (numbers, "I"/"we" statements, example markers) and answer length. Quotes are verbatim sentences from the matched turns. A criterion with no matching turn is marked insufficient evidence.
- **Extraction.**
  - Numbers: the number closest to a keyword in a sentence that mentions the variable. Dates such as ISO strings are excluded.
  - Booleans: yes/no answers to a question that mentions the variable.
  - Dates: ISO dates.
  - Lists: comma or colon lists.
  - Text: enum values mentioned, or the matching sentence.
  - Otherwise null.
- Results are always `simulated=true`, and the summary starts with "Simulated analysis (no AI provider configured)".

### Review API (`analysis.controller.ts`, `review.service.ts`, `export.service.ts`)
All routes are under `/api/workspaces/:workspaceId/sessions` and filtered by workspace. A session in another workspace, or a deleted one, returns 404.

| Method | Path | Capability | API-key scope |
|---|---|---|---|
| GET | `/` list: filters `scenarioId, versionId, participant, participantId, state, analysisStatus, channel` (comma lists allowed), `from, to, minScore, maxScore, courseId, teamId, simulated, needsReview`, cursor pagination | sessions.review | sessions:read |
| GET | `/facets` scenarios+versions, courses, teams for filters | sessions.review | sessions:read |
| GET | `/export.csv` filtered list + `score:<criterion>` + `extract:<key>` columns (max 5000 rows), audited | exports.download | analysis:read |
| GET | `/:id` full detail (debug `events` only for CREATOR+) | sessions.review | sessions:read |
| GET | `/:id/analysis` evaluation + extraction + processing | sessions.review | analysis:read |
| POST | `/:id/reprocess` (202, rate-limited 5 per 5 min per session, audited) | sessions.review | sessions:write |
| POST | `/:id/steps/:step/retry` (202, audited) | sessions.review | sessions:write |
| POST | `/:id/review` `{ note }` human sign-off (users only), audited | sessions.review | — |
| DELETE | `/:id` soft delete, deletes media objects and upload parts, clears the resume token, audited | **sessions.delete** (ADMIN, new) | sessions:write |
| GET | `/:id/export.pdf` pdfkit report, audited | exports.download | analysis:read |
| GET | `/:id/export.csv` transcript, audited | exports.download | analysis:read |

- **Detail response.** Returns:
  - the session, including consent, providerInfo, variables, metadata and error,
  - the scenario and its exact version (`number`, `id`, `isLatest`),
  - analysis settings, rubric meta and the participant,
  - turns and tool events,
  - the current evaluation with its criteria and evidence, plus evaluation history,
  - extraction results,
  - processing steps for the current generation,
  - media: signed URLs (`storage.signedUrl`, 10 min TTL) only for READY assets within session and asset retention, otherwise status `EXPIRED` or the asset's status,
  - `recordingUnavailableReason`: not enabled, no consent, expired, still uploading, failed, or none captured,
  - the `SessionReport.content`.
- **CSV.** Cells are RFC 4180 quoted, cells starting with `= + - @ \t \r` get a `'` prefix (real numbers are left alone), there is a UTF-8 BOM, and the `Content-Disposition` header carries an ASCII name plus a `filename*` UTF-8 name.
- **PDF contents:**
  - a header with scenario, version, participant and ids,
  - the overall score with uncertainty wording, or "Not enough evidence to score",
  - the human-review note,
  - a criteria table (weight, score, confidence) followed by rationale and evidence with turn numbers,
  - summary, strengths, areas to improve and next steps,
  - an extraction table with invalid values in red,
  - the full transcript with seq numbers and offsets,
  - when simulated, a banner and a diagonal **SIMULATED** watermark on every page.

  It uses DejaVu or Liberation fonts when installed (set `PDF_FONT_PATH` or `PDF_FONT_BOLD_PATH` to override), otherwise Helvetica with non-Latin characters replaced.

### Participant reports (`participant-report.service.ts`)
- `GET /api/runtime/sessions/:id/report` is public but needs `Authorization: Bearer cfs_…`. The token is checked with B's `SessionsService.verifySessionToken`, which is constant-time and enforces expiry (24 h). The route is rate-limited to 120 requests per minute per IP.
- `GET /api/me/sessions/:id/report` is for the logged-in user who is the participant (`participant.userId`).
- `GET /api/me/sessions?limit&cursor&workspaceId` lists the user's own sessions across workspaces for F's learner page. Each row has `overallScore` (only when visible), `scoresVisible`, `feedbackAvailable`, `analysisStatus` and `reportUrl`.
- What the report returns is set by the version:

  | Section | Returned when |
  |---|---|
  | transcript (agent and participant turns) | `participantCanSeeTranscript` |
  | feedback (summary, strengths, weaknesses, improvements) | `participantCanSeeFeedback` |
  | scores (overall, and per-criterion name, weight, score) | `participantCanSeeScores` **and** `rubric.visibility === 'participant_and_reviewers'` |

  When human review is required and not yet signed off, the scores section is replaced by `{awaitingReview:true}`.
- It never returns rationale, evidence, reviewer notes, extraction, notes or other sessions.

### Web
- **`/w/[id]/sessions`.** Filters are kept in the URL: debounced participant search, scenario → version, state, analysis status, plus "More filters" (channel, date range, score range, course, team, simulated, awaiting review).
  - Each row shows a processing badge and a simulated badge. It also shows a "Needs review" badge, and "Insufficient evidence" instead of a number when there is no score.
  - The list auto-refreshes while anything is processing, and has infinite "Load more".
  - The "Export CSV" button respects the filters and is hidden without `exports.download`.
- **`/w/[id]/sessions/[sessionId]`.** The header shows the participant, a link to the scenario editor for creators, a `v{n}` badge with a note when the session ran on an older version, channel, state, duration, date, consent summary and processing badge. It has export buttons and an admin-only Delete.
  - **Report tab:** simulated and partial-failure alerts, a human-review banner with a sign-off modal, the overall score with uncertainty wording, and per-criterion cards (weight badge, score bar or "Not enough evidence to score", confidence, rationale, evidence quotes). Clicking a quote opens the Transcript tab, scrolls to `#turn-<seq>` and highlights it. Also strengths, improvements and next steps, notes with turn links, and evaluation history.
  - **Transcript tab:** speaker, time offsets, interrupted and source markers, tool events inline at their time offset, search with highlighting, and `#turn-N` deep links.
  - **Recording tab:** audio or video player on the signed URL, or the reason there is none; also files uploaded during the session.
  - **Extracted data tab:** typed values, valid or invalid with errors, confidence, and evidence turn links.
  - **Processing tab:** per-step status, attempts and error, a Retry button on failed steps, and Reprocess all.
  - **Debug events tab:** CREATOR+ only.
- **`/report/[sessionId]`.**
  - The token is read with C's `readSessionToken` (a `#t=` fragment, then session or local storage). The page falls back to `/api/me/...` when the user is logged in.
  - It shows only the permitted sections, plus the simulated label and branding.
  - While processing it polls every 4 s with "Your feedback is being prepared…".
  - Expired or invalid links show a sign-in hint.

## Contract changes other workstreams must know
1. **Job ids carry a generation.** The job id is `pipeline_<sessionId>_<step>_g<generation>`, not `pipeline_<sessionId>_<kind>` as ARCHITECTURE.md says, because reprocessing needs new ids. The steps are `finalize_transcript`, `score`, `extract`, `report` and `notify`.
2. **Additive schema changes:**
   - `Session.analysisGeneration Int @default(0)`
   - `ProcessingJob.generation Int @default(1)`
   - `Evaluation.generation Int @default(1)`, plus `@@unique([sessionId, generation])`
3. **New capability** in `@cf/shared` `CAPABILITIES`: `'sessions.delete': 'ADMIN'`.
4. **Events.** `session.analyzed` fires on COMPLETED and PARTIAL, including when no rubric is configured (`evaluationId: null`). It may fire again after a reprocess or retry, so listeners must stay idempotent. `session.failed` with `errorCode:'analysis_failed'` means the *analysis* failed, not the conversation.
5. **Exported services.**
   - `AnalysisService`: `reprocess`, `retryStep`, `startPipeline`, `sweep`.
   - `ReviewService`: `list`, `detail`, `buildWhere`, `facets`, `review`, `remove`. H already uses `list` and `detail`.
   - `ExportService`.
   - `ParticipantReportService`: `forSession`, `forUser`, `listForUser`.
6. **B:** the participant report depends on `resumeTokenHash` and `resumeExpiresAt` staying set after a session ends. Anonymous report access therefore follows the token's 24 h TTL. Logged-in participants can use `/api/me/...` without that limit.
7. **Foundation fix.** `apps/api/scripts-db-sync.sh` now drops the generated `KnowledgeChunk.tsv` column before `prisma db push`, because Prisma cannot alter a generated column; `post-push.sql` recreates it. Without this, every `db:sync` after the first one failed.

## How it was tested
- **Unit tests** (`evidence.spec.ts`, `scoring.spec.ts`):
  - fabricated, wrong-turn, agent-turn, unknown and malformed quotes are dropped, while fuzzy and ellipsis quotes are kept,
  - the weighted score is computed in code and the model's "overallScore" is ignored,
  - a score with only fabricated evidence becomes insufficient, and coverage below the minimum gives no overall score,
  - protected-trait redaction,
  - CSV formula-injection escaping and quoting, and `Content-Disposition`,
  - simulator quotes all verify against the transcript, and the extraction heuristics work.
- **Integration tests** (`pipeline.int.spec.ts`, real Postgres `conversaforge_test_d`, inline dispatcher that mimics BullMQ retries):
  - `session.terminal` runs the full pipeline, including the timing fix, notifications and events,
  - idempotency: duplicate events and re-running steps never duplicate evaluations, criteria, extractions, jobs, notifications or usage rows,
  - reprocess after the scenario is republished with a different rubric still scores against v1, keeps history and sets a new current evaluation,
  - a fake real provider's fabricated evidence is dropped and invalid extraction values are stored with errors,
  - a provider failure makes the step FAILED after 4 attempts, the run PARTIAL, and the prior evaluation stays current; retry then completes,
  - both core steps failing gives FAILED and `session.failed`,
  - skip reasons,
  - the sweep resumes a lost job,
  - cross-workspace 404 on detail, reprocess, retry, review, delete and list,
  - score-range filter and CSV export with injection escaping, plus PDF generation,
  - participant report visibility in three configurations, awaiting review, and another user getting 404,
  - review sign-off and delete, with audit rows.

  Result: **25/25 passing** (`npx jest src/modules/analysis`). The shared vitest suite passes 48/48.
- **Live journey** (API on :4104 with its own Redis DB 4, web on :3104):
  1. Fixture created, `session.terminal` emitted, and the pipeline completed through BullMQ.
  2. A real conversation driven through **B's engine**: member self-run, consent, WebSocket hello/start, three participant turns, end. This analyzed automatically with an overall score of 60.9 (simulated) and extracted `follow_up_date=2026-10-06` and `decision_makers=[controller, IT, procurement]`.
  3. Reprocess generations 2–4, and review sign-off.
  4. PDF (2 pages, watermark), transcript CSV and filtered list CSV downloaded, both with curl and through the UI.
  5. Participant report by token, and by logged-in user.
  6. A workspace with an invalid Anthropic key: the real Anthropic SDK call returned 401, the step went straight to FAILED with no retries, and the run was FAILED. After the key was removed, Retry in the UI or API completed it.
  7. Role checks: MEMBER gets 403 on the list; REVIEWER gets no debug events and 403 on delete. A cross-origin POST was blocked. An API key with only `sessions:read` can list but gets 403 on PDF and reprocess. An outsider gets 404.
  8. Playwright (Chromium) screenshots confirmed the list, report, evidence → transcript highlight, `#turn-6` deep link, audio playback through the signed URL (200 audio/wav), failed-step Retry, and the participant report with the `#t=` token stripped from the URL. There were no page errors.

## Incomplete or externally blocked
- **Real LLM analysis is untested with a valid key.** The Anthropic path was only exercised up to authentication: a real request reached the API and was rejected with 401 for the invalid key. It needs `ANTHROPIC_API_KEY` (or a workspace provider connection) to verify prompt quality and the structured-output schema end to end. The OpenAI path (`response_format: json_schema`, strict false) is untested; it needs `OPENAI_API_KEY`.
- **Server re-transcription** of recordings in `finalize_transcript` is not implemented; it was optional and is off by default. The step records `retranscribed:false`.
- **Email notifications** use `MailService`. Without `SMTP_URL` they are only logged.
- **Bulk CSV export** is capped at 5000 rows per request; narrow the filters for more.
- **Shared dev environment:** every API process started with `RUN_WORKERS_IN_API=true` against the same Redis consumes `session-pipeline` jobs, possibly with an older compiled copy of this code. For isolated manual testing, run with a separate Redis DB, e.g. `REDIS_URL=redis://localhost:6379/4`.
