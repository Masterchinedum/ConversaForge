# Workstream B — Live session runtime

Module: `apps/api/src/modules/runtime` (exports `SessionsService`, `RuntimeService`, `SpeechService`).
A participant can hold a complete voice conversation with an agent that follows the scenario version's
goals/agenda, forms follow-ups from what they actually said, handles barge-in, pauses, reconnects and
timers, and ends gracefully. Everything works end to end with the clearly-labeled local **simulator**;
real-provider paths are implemented against the current SDKs and verified with local mock servers (see
"Verification" — no real provider key was available, so no real-provider conversation was run).

## What was built

| Area | Files |
|---|---|
| Session creation contract | `sessions.service.ts` (`createSession`, `verifySessionToken`, `load`), `sessions.controller.ts` (member self-run) |
| Participant REST | `participant.controller.ts`, `recordings.service.ts`, `client-config.service.ts` |
| WebSocket gateway | `runtime.gateway.ts`, `protocol-schema.ts` (zod validation of every inbound message) |
| Engine registry / transport API | `runtime.service.ts`, `engine/transport.ts` |
| Conversation engine | `engine/session-engine.ts` (state machine, timers, generation loop, barge-in, persistence) |
| Prompt compiler | `engine/prompt-compiler.ts`, `engine/history.ts` |
| Simulator agent | `engine/simulator-agent.ts` |
| Tools | `tools/tool-registry.ts`, `tools/json-schema.ts` |
| Voice providers | `voice/provider-resolver.service.ts`, `voice/realtime.service.ts`, `voice/speech.service.ts` |
| Soft deps on G/F | `optional-deps.service.ts` (KnowledgeService, CustomFunctionsService, MemoryService via `ModuleRef`, no static import) |
| Tests | `engine/*.spec.ts`, `tools/tool-registry.spec.ts`, `sessions.service.spec.ts`, `runtime.e2e.spec.ts`, `testing/fixtures.ts` |

Shared/foundation edits (additive only):
- `common/llm/llm.types.ts`: `ChatRequest.systemDynamic?`, `LlmMessage.raw?` (provider-native assistant content), `done.raw?`.
- `common/llm/anthropic.provider.ts`: second system text block (no `cache_control`) for `systemDynamic`; assistant `raw` replayed verbatim (keeps signed `thinking` blocks for in-turn tool continuation); `done.raw` returned.
- `common/llm/openai.provider.ts`: `systemDynamic` sent as a second system message.
- `packages/shared/src/protocol.ts`: optional `TurnDTO.simulated/kind`, `SessionSnapshot.phase/progress/voiceMode/fallbacks`, new server message `realtime.instruction`, protocol notes (see below).

## Contracts for other workstreams

### `SessionsService` (as in ARCHITECTURE.md, plus two optional fields)
```ts
createSession({ workspaceId, scenarioId, versionId?, channel, participant, variables?, metadata?,
  shareLinkId?, accessTokenId?, enrollmentId?, courseItemAttemptId?, coachMode?,
  consent?: { recordAudio, recordVideo, analysis, source? },   // NEW optional: consent already collected → session starts READY
  externalRef?: string })                                         // NEW optional: e.g. Twilio CallSid
  → { session, sessionToken /* cfs_… shown once */ }
verifySessionToken(sessionId, token) → Session   // 404 unknown, 401 bad/expired (constant-time sha256 compare)
load(sessionId) → { session, config, scenario, version }
```
- Version: pinned `versionId` must belong to the scenario + workspace (else 404); default = `latestVersionId`; none → `409 "Scenario has no published version"`; archived → 409; deleted → 404.
- Participant upsert: externalId → userId → email (lower-cased) → new.
- Variables: `resolveVariables(allowlist, {participant_name from participant.name}, input.variables)`; missing/invalid required → **422** listing `variables.<key>`; non-allowlisted keys dropped (recorded in the `session.created` event).
- `usage.assertWithinQuota` (402). `maxDurationSec = min(config max, workspace settings.maxSessionMinutes ?? DEFAULT_MAX_SESSION_MINUTES) * 60`.
- Token `cfs_` + 256-bit random; only `sha256` stored in `resumeTokenHash`; `resumeExpiresAt = now + 24h`.
- `providerInfo` = `{ voiceMode, requestedVoiceMode, llm:{provider,model,source}, stt, tts, realtime?, simulated, simulatedParts, fallbacks[] }`. Realtime without an OpenAI key falls back to `pipeline` and records why; server STT/TTS without keys fall back to `browser`. If the workspace sets `settings.allowSimulator=false` and no LLM key exists → 503.
- Member self-run: `POST /api/workspaces/:workspaceId/scenarios/:scenarioId/sessions` `{ variables?, coachMode?, enrollmentId?, courseItemAttemptId? }` → `{ sessionId, sessionToken }`. PRIVATE scenarios require CREATOR+ (404 otherwise); enrollment must be the caller's; attempt must belong to that enrollment/scenario. 30/min/user.

### Consent → analysis
`Session.consent = { recordAudio, recordVideo, analysis, acceptedAt, noticeVersion, source }`. If the participant declines analysis (or analysis is disabled), `consent.analysis=false` **and** `Session.analysisStatus='SKIPPED'` is set (again at terminal) — workstream D must skip the pipeline for such sessions.

### Domain events
`session.started` (first ACTIVE) and `session.terminal` `{ sessionId, workspaceId, state }` exactly once per terminal transition. `SESSION_SECONDS` usage is recorded once (`session:<id>:seconds`, quantity = active conversation seconds, paused/reconnecting time excluded); realtime sessions also record `REALTIME_SECONDS` (`session:<id>:realtime_seconds`). LLM turns: `recordLlm(..., 'turn:<sessionId>:<seq>')` (+`:r<n>` per extra tool round). TTS: `TTS_CHARACTERS`; STT: `STT_SECONDS` (provider-reported duration, or estimated from bytes — flagged `metadata.estimated`); recordings: `STORAGE_BYTES`.

### Transport-agnostic engine (phone / meetings — used by workstream H)
```ts
interface EngineTransport { kind: string; send(msg: ServerMessage): void; close(code: number, reason: string): void }
const conn = await runtimeService.attach(sessionId, sessionToken, transport, { lastSeq?, clientInstanceId? });
conn.receive(clientMessage);   // same ClientMessage protocol as the browser
conn.detach();                 // connection gone → RECONNECTING (90 s grace) → ABANDONED
// Engine helpers (queued, safe to call from outside):
const engine = await runtimeService.getEngine(sessionId);
await engine.closeSession(reason, endedBy);   // graceful: closing line → ENDING → COMPLETED
await engine.fail(code, message);             // FAILED with errorCode
```
Engines live in memory: run one API instance or route `/ws/session` and media streams with session affinity. On restart the engine is rebuilt from the DB on the next `hello` (time is folded up to the last heartbeat); a sweeper (only in processes with workers) abandons live sessions whose heartbeat is >3 min old, PAUSED > 31 min, and expires CREATED/READY older than 24 h — all multi-instance safe (compare-and-set state updates).

## Participant REST (`@Public`, `Authorization: Bearer cfs_…`)
| Route | Notes |
|---|---|
| `GET /api/runtime/sessions/:id` | bootstrap: `session` (state, times, durationMs, stateReason, endedBy, maxDurationSec, lastSeq, terminal), `scenario` (name, type, description, participantInstructions with variables substituted, targetDurationMinutes, language), `persona`, `participant.name`, `consent` (required, given, recordAudio/Video, analysis, retentionDays, notice (author's or a generated default), noticeVersion, recorded), `report` visibility flags, `config` (`ClientRuntimeConfig` incl. branding from `WorkspaceBranding`), `simulated`, `simulatedParts`, `providerFallbacks`. 120/min. |
| `POST …/consent` `{recordAudio, recordVideo, analysis}` | CREATED→READY (re-consent allowed until start). Flags are ANDed with what the scenario records. |
| `POST …/realtime-token` | 409 unless `providerInfo.voiceMode==='realtime'`; returns `{ provider:'openai', model, clientSecret, expiresAt, callsUrl, voice }`. 10/min. |
| `POST …/recordings` `{kind:'audio'|'video', mimeType}` → `{assetId}` | 403 without the matching consent/scenario flag; ≤ 6 per session. |
| `PUT …/recordings/:assetId/parts/:n` (binary body) | idempotent per part number (retries replace), ≤ 8 MB/part (UPLOAD_LIMITS), type from UPLOAD_LIMITS.recordingPart, ≤ 400 MB total. |
| `POST …/recordings/:assetId/complete` `{durationMs?}` | parts must be contiguous 1..N; concatenated into one object; MediaAsset READY, sha256, `retentionUntil = now + recording.retentionDays`; parts deleted. Idempotent. Allowed up to 15 min after COMPLETED/ABANDONED. |
| `POST …/uploads?toolCallId=` (multipart `file`) | document_upload: enabled-tool check, UPLOAD_LIMITS.toolDocument type/size, PDF magic check, stored as TOOL_UPLOAD under `ws/<id>/sessions/<sid>/uploads/`, text via `KnowledgeService.extractText` (fallback: utf-8 text / `unpdf`), → `{ assetId, fileName, textPreview, chars, pageCount }`. Text is persisted as a SYSTEM turn (`kind:'document'`) and fed to the agent as `<uploaded_document>` untrusted data; the agent replies. |
| `POST …/tts` `{text ≤1500, format?}` | OpenAI `gpt-4o-mini-tts` (or `OPENAI_TTS_MODEL`) or ElevenLabs `eleven_flash_v2_5`; returns audio bytes. **503 `provider_unavailable`** “Set OPENAI_API_KEY or ELEVENLABS_API_KEY” when neither is configured. |
| `POST …/stt` (binary audio ≤ 2 MB) | OpenAI `gpt-4o-mini-transcribe` or Deepgram `nova-3` prerecorded → `{ text, confidence, durationSec, provider }`. 503 “Set OPENAI_API_KEY or DEEPGRAM_API_KEY”. |

The runtime module registers Fastify buffer parsers for `application/octet-stream`, `audio/*` (webm/ogg/mp4/mpeg/wav) and `video/webm|mp4` (10 MB), only if not already registered.

## WebSocket `/ws/session`
Protocol: `packages/shared/src/protocol.ts`. Behavior:
- First message `hello` within 10 s (60 hellos/min/IP); bad token → `error` + close 4001; protocol mismatch → 4004. `welcome` carries snapshot (+`phase`, `progress`, `voiceMode`, `fallbacks`), config, transcript (all turns, or only `seq > lastSeq` when `lastSeq` is sent), open tools, `resumed`.
- One active connection per session: a newer `hello` sends `error{code:'superseded'}` to the old socket and closes it with 4003.
- `start`: CREATED needs consent (`error consent_required`) unless the scenario records nothing and has analysis off; READY → CONNECTING → ACTIVE, `session.started`, then the scripted first turn (variables substituted) when the agent speaks first. Idempotent.
- Participant turns: `participant.final` → TranscriptTurn with next `seq` and `clientTurnId` (unique per session → resends echo the existing `turn.saved`, never duplicate) → agent reply streamed `agent.start`/`agent.delta`/`agent.end` (turnId == persisted TranscriptTurn id) → `turn.saved`.
- Barge-in: `participant.speaking:true` during generation (and `allowBargeIn`) aborts it; the streamed part is persisted `interrupted:true` (`metadata.generatedText` keeps the full text); `agent.playback interrupted {spokenChars}` truncates the stored turn to what was actually heard (word boundary) and re-sends `turn.saved`. If the "barge-in" was only a noise (no final within endOfTurnSilence+2.5 s) the agent resumes briefly.
- Pauses for thought never trigger replies. Silence check-in only after `silenceCheckInMs` without partials/speaking/finals, measured from the end of agent playback, once per silence, never while speaking or while a timer tool runs.
- Controls: pause (ACTIVE→PAUSED, time frozen; > 30 min → ABANDONED), resume, end (if `allowParticipantEnd`; closing line spoken immediately → ENDING → COMPLETED after `agent.playback completed` or a speech-length timeout), mute/unmute (logged).
- Disconnect → RECONNECTING (time frozen), reconnect within 90 s → ACTIVE/PAUSED, else ABANDONED. An aborted generation is not persisted on disconnect; on resume an unanswered participant turn is answered.
- Timers: `timer` every 5 s; timed instructions (`nudge`/`wrap_up` are queued into the next reply's dynamic block — never trigger speech, never interrupt; `end` closes, deferred while the participant speaks); wrap-up instruction + `notice` at `wrapUpLeadMinutes` before the cap (deferred while speaking); hard cap → closing line (deferred ≤ 30 s if mid-answer) → COMPLETED `endedBy:'timer'`.
- Every transition goes through `assertTransition`, is compare-and-set in the DB, logged as `SessionEvent state.changed {from,to,reason}` and broadcast as `state`. Terminal: `durationMs`, `endedAt`, `endedBy`, `retentionUntil`, usage once, `session.terminal`, `end` message, close 4002; later messages get `error session_terminal`.
- Limits: 128 KB frames, token bucket 40 msg/s (burst 120), `participant.final` ≤ 4000 chars (`error too_large`), partial ≤ 2000, tool payloads ≤ 20 KB, `client.event` data ≤ 4 KB (stored as `SessionEvent client.event`).
- SessionEvent types written: `session.created`, `state.changed`, `connection.*`, `consent.recorded`, `provider.turn` (provider/model/ttftMs/totalMs/tokens/tools per reply), `provider.error|refusal|max_tokens|empty_reply|realtime_token|tts_error|stt_error`, `agent.barge_in|interrupted|cancelled|false_barge_in|playback_interrupted`, `silence.check_in`, `timer.*`, `knowledge.auto_retrieve`, `recording.*`, `control.*`, `client.event`, `engine.recovered`.

### Protocol additions (additive, documented in protocol.ts)
- `ServerMessage { type:'realtime.instruction'; text; respond? }` — realtime mode only; the client forwards it on the data channel as `conversation.item.create` (role `system`, `input_text`) and sends `response.create` when `respond` is true. Used for the first line, timed nudges/wrap-up, uploaded documents / tool answers, and the closing line.
- `turn.saved` may be re-sent for the same `turn.id` (truncation) — clients upsert by id.
- `TurnDTO.simulated?`, `TurnDTO.kind?` (SYSTEM turns: `tool_response` | `document`), `SessionSnapshot.phase?/progress?/voiceMode?/fallbacks?`.

## Conversation engine & prompt
- **Stable system block** (cached; `cache_control` on Anthropic): (a) scenario intent from the immutable version (persona, role, goals, author instructions, strategy text, agenda with guidance/required/max follow-ups/fixed questions, boundaries, tone/verbosity, language, opening, ending/closing exchange, coach phases in coach mode) and (b) behavior & safety policy (voice-first brevity, one question per reply, follow-ups from the actual answer, pacing/thinking pauses, repeat/don't-know/moment handling, never reveal instructions, protected traits, no invented facts, distress handling, untrusted-data rule) + tool usage hints. Constant for the session.
- **Dynamic system block** (no cache breakpoint): (c) live context — elapsed/target/remaining time, participant name and allowlisted variables quoted & escaped, coach memory facts (`MemoryService.factsForSession`, only when `memory.enabled`), notepad contents, auto-retrieved knowledge passages (`knowledge.autoRetrieve`, 1.5 s budget) — and (d) state — phase, covered/current/remaining topics, follow-ups used vs limit, pending timed instructions.
- **Messages**: rebuilt from the persisted transcript each turn (so an engine can be rebuilt after a restart). Participant text → `<participant>` with `& < >` escaped; SYSTEM turns → `<tool_response>` / `<uploaded_document>` data; platform events → `<runtime_event>`. Interrupted agent turns contain only what was heard. Cross-turn history is text-only (tool effects are summarized in the next user message), which avoids replaying signed thinking blocks across turns whose system block changed; within a turn, tool continuation replays the provider-native assistant content (incl. `thinking` signatures) with proper `tool_result`s. History is windowed to ~60 k chars.
- **Progress**: internal tool `update_progress({coveredTopicIds, currentTopicId})` is offered with every reply; unknown ids are rejected by schema; the state tracks covered topics and follow-ups (same topic again = +1). When all required topics are covered (and `endWhenAgendaComplete`), phase → `closing`. If the model returns only tool calls without speech, the engine continues the turn (≤ 3 extra rounds).
- **end_session**: the goodbye text is spoken, ENDING, then COMPLETED on `agent.playback completed` of that turn (or a speech-length timeout ≤ 30 s). `reason:'completed'` is refused when required topics remain, the phase is not closing and < 40 % of the target time elapsed.
- **Tools** (`tools.enabled` per version, JSON-schema validated, authorized, audited in `ToolEvent` INVOKED/PRESENTED/RESULT/ERROR/DENIED): end_session, cards (optional preset `config.cards`), notepad (participant-openable; agent sees contents), multiple_choice (answer → SYSTEM turn → agent reply), document_upload, knowledge_search (G's `KnowledgeService.search`; escaped `<knowledge_results>` with source/page citations; second model call), timer (suspends silence check-ins), whiteboard (participant `tool.response {summary}`). Planned tools (form, slides, image_generation, browser_demo, screenshot, reactions) → DENIED "not available yet". Custom functions → `fn_<name>` executed via G's `CustomFunctionsService.execute` (runtime writes the ToolEvents; `logToolEvent:false`). UI is presented only when a tool is actually invoked.
- **LLM loop**: text deltas streamed as they arrive; refusal → safe fallback line + `provider.refusal`; `max_tokens` → trimmed to the last sentence; provider error → non-fatal `error llm_error`; 3 consecutive failures → FAILED `errorCode=llm_unavailable`. Anthropic: Opus 5 default (`ANTHROPIC_LIVE_MODEL`), `output_config.effort:'low'`, no `temperature` on models that reject it, adaptive thinking left at the model default.
- **Simulator**: `engine/simulator-agent.ts`, passed via `simulate`. Deterministic, agenda-walking, keyword-based follow-ups for short/vague answers, respects `maxFollowUps` (fixed strategy ≤ 1), handles repeat / don't know (one gentler reframe, then move on) / "a moment" / stop requests, closing exchange, `end_session`; emits `update_progress`. Every simulated agent turn has `source:'simulated'`, `metadata.simulated:true`; `providerInfo.simulated` and `ClientRuntimeConfig.simulated` are true.

## Realtime mode (OpenAI)
`POST …/realtime-token` compiles the stable + current dynamic prompt and the toolset and calls `openai.realtime.clientSecrets.create` (`POST /v1/realtime/client_secrets`, `session.type:'realtime'`, model `OPENAI_REALTIME_MODEL` (gpt-realtime), `instructions`, `tools` as `function` tools, `audio.input.transcription` gpt-4o-mini-transcribe, `turn_detection: semantic_vad eagerness low` (thinking pauses), `interrupt_response = allowBargeIn`, `audio.output.voice` (persona voiceId if a valid realtime voice, else `marin`)), `expires_after` 600 s. The API key never leaves the server. The browser POSTs its SDP offer to `https://api.openai.com/v1/realtime/calls` with the ephemeral secret, mirrors transcripts (`realtime.transcript`, deduped by `rt_<itemId>`) and tool calls (`realtime.tool_call` → server executes → `realtime.tool_result`). The server never generates replies in this mode; timers/instructions/closing are pushed as `realtime.instruction`. `REALTIME_SECONDS` usage at the end. Could not be tested against OpenAI (egress to platform.openai.com is blocked and no key); implemented from the installed `openai@5.23.2` type definitions and verified against a mock server.

## Credentials needed for real (non-simulated) runs
- **LLM (pipeline mode, browser STT/TTS):** `ANTHROPIC_API_KEY` (default model `claude-opus-5`; alternatives `claude-sonnet-5`, `claude-haiku-4-5` via `ANTHROPIC_LIVE_MODEL`) **or** `OPENAI_API_KEY` (`OPENAI_LIVE_MODEL`). Workspace provider connections (G) take precedence over env keys.
- **Realtime voice, server TTS/STT:** `OPENAI_API_KEY` (models `OPENAI_REALTIME_MODEL`, `OPENAI_TTS_MODEL`, `OPENAI_STT_MODEL`).
- **Optional:** `DEEPGRAM_API_KEY` (server STT), `ELEVENLABS_API_KEY` (server TTS).
- Set `ALLOW_SIMULATOR=false` (or workspace `settings.allowSimulator=false`) in production to refuse simulated sessions.

## Verification (actual results)
- `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/conversaforge_test_b npx jest src/modules/runtime` → **5 suites, 43 tests passed** (~35 s). Without a test DB the 21 unit tests run and integration suites are skipped.
  - Unit: prompt separation/caching stability/escaping/variables quoted/boundaries/protected traits/coach block; history alternation & data wrapping; simulator walk (follow-ups from keywords, maxFollowUps, repeat, moment, stop, don't-know, closing + end_session); JSON-schema validator; tool authorization (disabled/planned/unknown/custom denied, audit rows), knowledge results escaping; state machine legal/illegal/terminal transitions.
  - Integration (`sessions.service.spec.ts`): latest vs pinned version (cross-scenario and cross-workspace 404), unpublished/archived/deleted, variable allowlist/sanitizing/required 422, participant upsert order, quota 402 & duration cap, token verification (bad/expired), realtime→pipeline fallback, ScenarioVersion unchanged and DB trigger rejects updates.
  - WS end-to-end against an in-process Nest app (listen on an ephemeral port): consent gating, hello/welcome, start → first turn, follow-ups, duplicate `clientTurnId` not duplicated, participant end → closing → COMPLETED with contiguous seqs, exactly one SESSION_SECONDS row and one `session.terminal`; disconnect/resume with `lastSeq`; superseding (4003); rebuild after simulated API crash; barge-in truncation; silence check-in once; pause/resume and illegal control; participant notepad; multiple-choice answer delivered + nudge not triggering speech while the participant talks; document upload (text extraction, SYSTEM turn, reply, bad type 422); recordings (consent 403, idempotent parts, concatenation, retention, analysis-declined → `SKIPPED`); max-duration cap → COMPLETED `endedBy:timer`; TTS/STT 503 + realtime 409 without keys; malformed/oversized/unauthenticated messages; **Anthropic contract** via a local mock of the Messages streaming API (two system blocks with/without `cache_control`, tools, escaped participant text, `output_config.effort`, thinking-signature passthrough on continuation, usage keys `turn:<id>:<seq>` / `:r1`); **OpenAI realtime contract** via a mock `/v1/realtime/client_secrets` + realtime transcript/tool mirroring + REALTIME_SECONDS; repeated provider failure → FAILED `llm_unavailable`; sweeper → ABANDONED / EXPIRED.
- Manual run: API on :4102 (`node .dist-b/main.js`), scenario created and published through workstream A's endpoints from the `behavioral-interview` template, session via the member self-run endpoint, conversation driven by a node `ws` script (simulator):

```
AGENT: Hi Jamie Rivera, thanks for joining. I'm Alex. We'll spend about ten minutes on a few questions about your past experience. Ready to start?
PARTICIPANT: Yes, ready when you are.
AGENT: Great. Let's start. I'd like to hear about brief introduction and current role. Could you tell me about that?
PARTICIPANT: I am a backend engineer at a fintech company.
AGENT: You mentioned backend engineer — what was your specific role in that?
PARTICIPANT: I own the payments reconciliation service at Northwind, a team of five, mostly Go and Postgres, and I have been there three years.
AGENT: Thanks — that's helpful context on Northwind. Moving on. I'd like to hear about a time you resolved a disagreement. Could you tell me about that, with a specific example?
PARTICIPANT: We disagreed on a design once.
AGENT: Could you tell me a bit more about design? What happened, and what was the result?
PARTICIPANT: Hmm, give me a moment to think.
AGENT: Sure, take your time — just start whenever you are ready.
PARTICIPANT: Our lead wanted to rewrite the ledger in Rust while I argued for incremental fixes, so I wrote a one page comparison with latency data, we agreed on a two week spike, and the spike showed the fixes were enough.
AGENT: Got it — Rust sounds like a meaningful example. Moving on. I'd like to hear about your most measurable accomplishment. Could you tell me about that, with a specific example?
PARTICIPANT: Sorry, could you repeat the question?
AGENT: Of course. I'd like to hear about your most measurable accomplishment. Could you tell me about that, with a specific example?
PARTICIPANT: I cut our nightly batch from six hours to forty minutes by parallelizing reconciliation with Kafka partitions, which let finance close the books a day earlier.
AGENT: That's a clear example, thanks for walking me through Kafka. That covers everything I wanted to ask. Before we wrap up, is there anything you would like to add, or any question for me?
PARTICIPANT: What does the team you are hiring for work on?
AGENT: Good question — the team will follow up with details on that. Thanks for your time today — that is everything I wanted to cover. Best of luck!
[state → ENDING (agent_completed)] [state → COMPLETED (completed)] [end reason=completed by=agent] closed 4002
```
  Afterwards the session was COMPLETED with `SESSION_SECONDS` recorded once, 9 `provider.turn` events, `update_progress`/`end_session` ToolEvents, and workstream D's pipeline had already analyzed it.

## Known limitations / follow-ups
- No real provider conversation was run (no keys; OpenAI docs host blocked). Anthropic/OpenAI request shapes are verified against local mocks only.
- The simulator is rule-based: phrasing of agenda topics written as noun phrases can sound mechanical ("I'd like to hear about brief introduction and current role").
- Engines are per-process; multi-instance deployments need session affinity for `/ws/session` (not yet in DEPLOYMENT.md — lead to add).
- Server-side TTS streaming over the WS (`agent.audio`) is not used by the browser pipeline; phone (H) calls `SpeechService` directly.
- Recording concatenation happens in memory (≤ 400 MB cap per asset); a streaming multipart upload to S3 would scale better.
