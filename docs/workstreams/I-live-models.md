# Workstream I — Live speech-to-speech models (OpenAI Realtime + Google Gemini Live) and Gemini text

Product decision: live conversations use a **speech-to-speech "live" model by default** — OpenAI Realtime
(already built in B/C) or **Google Gemini Live** (new). The STT → LLM → TTS **pipeline** is the automatic
fallback when no live-model credential is configured (and stays selectable per scenario). Text models are
still used for scoring/extraction, the drafting assistant and coach memory, and **Google Gemini is now a text
provider too**, so a customer with only a Google key gets a fully working product.

> Nothing here was run against Google or OpenAI: no keys exist in this environment and Google's API/docs
> hosts return 403 through the proxy. Everything is implemented against the installed SDK's type
> declarations and exercised with local mocks (details below). A real run needs the credentials listed at
> the end.

## What was built

| Area | Files |
|---|---|
| Shared config (additive) | `packages/shared/src/scenario-config.ts`: `model.voiceMode` default **`realtime`**; `model.realtimeProvider` ∈ `auto \| openai \| google` (default **`auto`**); `model.llmProvider` gains `google`; publish warnings for a live-model override that doesn't match the chosen provider and for live voice + phone/meeting channels. `protocol.ts`: `ClientRuntimeConfig.realtime.provider` is `openai \| google`, new optional `requestedVoiceMode`. Existing versions that say `openai`/`pipeline` are unchanged. |
| Env | `GEMINI_API_KEY` (alias `GOOGLE_API_KEY`), `GEMINI_LIVE_MODEL` (default `gemini-2.5-flash-native-audio-latest`), `GEMINI_TEXT_MODEL` (`gemini-2.5-flash`), `GEMINI_ANALYSIS_MODEL` (`gemini-2.5-pro`), `GEMINI_BASE_URL` (proxies/tests) — `apps/api/src/config/env.ts`, `/.env.example` |
| Google text LLM | `apps/api/src/common/llm/google.provider.ts` (`GoogleProvider`: `streamChat`, `completeJson`), wired in `llm.service.ts` (`resolve`, `defaultModel`, `availability().google`, `providerSecret(ws,'google', capability?)`) |
| Provider connections | `modules/providers/provider-catalog.ts` (`google`: LLM + REALTIME), `provider-verify.ts` (models.list), `providers.service.ts` (status rows: live voice lists OpenAI/Google, settings keep `liveModel/analysisModel/realtimeModel/voice`); web `settings/providers/page.tsx` |
| Resolver | `modules/runtime/voice/provider-resolver.service.ts` (`pickLiveProvider`, `liveModel`, fallback reasons) |
| Token minting | `modules/runtime/voice/realtime.service.ts` (`mintGoogle`, `geminiLiveConfig`, `GEMINI_VOICES`, `GEMINI_TOKEN`), `participant.controller.ts` (`POST …/realtime-token { resumeHandle?, reconnect? }`), `engine/session-engine.ts` (`realtimeSetup({ withHistory })`, REALTIME_SECONDS + agent-turn metadata carry the provider) |
| Pricing | `modules/usage/pricing.ts`: Gemini text models + `google:realtime` per-minute — **estimates** |
| Client adapter | `apps/web/src/lib/voice/gemini-live.ts` (`GeminiLiveAdapter`), `runtime-api.ts` (`fetchGeminiToken`), `index.ts` (plan + selection + `voiceLabel`), `openai-realtime.ts` (label, typed text → model) |
| Live UI | `CallScreen.tsx` ("Voice: Google Gemini Live", **"Live voice unavailable — using …"** chip), `DeviceCheck.tsx` (planned mode + fallback note), `use-live-call.ts` (`voiceLabel`, `liveFallback`, typed input forwarded to live models) |
| Scenario editor | `components/scenarios/sections.tsx` → Model & providers: voice mode (Live vs Pipeline, trade-off help), live provider (Auto / OpenAI Realtime / Google Gemini Live), live model override, LLM list with Google |
| CSP | `apps/web/next.config.mjs`: `connect-src wss://generativelanguage.googleapis.com` |
| Dependency | `@google/genai@2.24.0` (Apache-2.0) in `apps/api` and `apps/web` (pinned: the README warns of breaking changes in 3.x). The browser loads it lazily (separate chunk) only for Gemini sessions. |

### Provider resolution (`providerInfo`)
- `voiceMode:'realtime'` requested:
  - phone/meeting channel → `pipeline` + reason ("browser only").
  - `realtimeProvider:'auto'` → first provider with a live credential in the order **openai → google**.
  - `'openai'`/`'google'` → that provider if configured, otherwise **the other one** with a reason
    ("Google Gemini Live was requested but no Google key (GEMINI_API_KEY …) is configured; using OpenAI Realtime instead."),
    otherwise `pipeline` with a reason.
  - A credential counts when a workspace connection for that provider has the **REALTIME** capability
    checked (or has no capability list), else the server env key.
  - Model: the scenario's `realtimeModel` when it belongs to the chosen provider (`gemini…` ↔ Google), else
    the connection's `realtimeModel`, else `OPENAI_REALTIME_MODEL` / `GEMINI_LIVE_MODEL`.
- Recorded as `providerInfo.realtime = { provider, model, source }`, `requestedRealtimeProvider`,
  `requestedVoiceMode`, `fallbacks[]`; the client gets `config.realtime`, `config.requestedVoiceMode`.
- Text LLM: `LlmService.resolve(ws, purpose, preferred)` → preferred first, then anthropic → openai → google
  (workspace connection with `kind:'LLM'` first, then env key), else the simulator. Google defaults:
  `GEMINI_TEXT_MODEL` for `live`, `GEMINI_ANALYSIS_MODEL` for analysis/assistant/memory.
- No keys: realtime requested → pipeline + simulator, exactly as before (the notice says why).

### `POST /api/runtime/sessions/:id/realtime-token` (Google)
Body (optional): `{ resumeHandle?: string (≤2048 printable), reconnect?: boolean }`. 10/min/session, 409 unless the
session's voice mode is realtime, 503 naming `GEMINI_API_KEY` if the credential disappeared.
Server call (`@google/genai`, `new GoogleGenAI({ vertexai:false, apiKey, apiVersion:'v1alpha' })`):
```ts
ai.authTokens.create({ config: {
  uses: 1,                                   // single use; resuming a session doesn't consume a use
  expireTime: now + 30 min,                  // session messages rejected after this
  newSessionExpireTime: now + 2 min,         // must connect within 2 min
  liveConnectConstraints: { model, config: {
    responseModalities: [AUDIO],
    systemInstruction: { parts: [{ text: stable + dynamic prompt (+ <conversation_so_far> on reconnect) }] },
    tools: [{ functionDeclarations: [{ name, description, parametersJsonSchema }] }], // same set as OpenAI: catalog tools, fn_* custom functions, update_progress, end_session
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } /* + languageCode for non-native-audio models */ },
    inputAudioTranscription: {}, outputAudioTranscription: {},
    realtimeInputConfig: { automaticActivityDetection: { endOfSpeechSensitivity: END_SENSITIVITY_LOW, silenceDurationMs: clamp(endOfTurnSilenceMs, 500..3000) },
                           activityHandling: allowBargeIn ? START_OF_ACTIVITY_INTERRUPTS : NO_INTERRUPTION },
    sessionResumption: { handle? }, contextWindowCompression: { slidingWindow: {} } } },
  httpOptions: { apiVersion: 'v1alpha' } } })   // no lockAdditionalFields → whole setup locked
```
Response to the browser: `{ provider:'google', model, token:'auth_tokens/…', apiVersion:'v1alpha', expiresAt, newSessionExpiresAt, voice, connectConfig:{ responseModalities, inputAudioTranscription, outputAudioTranscription, sessionResumption }, audio:{ inputMimeType:'audio/pcm;rate=16000', outputSampleRate:24000 }, resumed }`.
Never the real key, the instructions or the tool list. `SessionEvent provider.realtime_token {provider, model, expiresAt, resumed, reconnect}`.

### Browser adapter (`GeminiLiveAdapter`)
- `new GoogleGenAI({ apiKey: token, apiVersion:'v1alpha' }).live.connect({ model, config: connectConfig, callbacks })`
  (15 s timeout — the SDK never rejects if the socket fails before `open`).
- Mic → AudioWorklet (blob module; 2 s timeout) or ScriptProcessor → exact 100 ms chunks → downsample to
  16 kHz → PCM16 LE base64 → `sendRealtimeInput({ audio: { data, mimeType:'audio/pcm;rate=16000' } })`; only
  while listening (not muted/paused, push-to-talk held). Mute/pause/PTT release/"I'm done" →
  `sendRealtimeInput({ audioStreamEnd: true })`.
- Model audio (`serverContent.modelTurn.parts[].inlineData`, `audio/pcm;rate=24000`) → the shared
  `AudioPlayer` (WebAudio queue → speakers **and** the recording mix), `agentSpeaking` from audibility.
- Transcripts: `inputTranscription` → participant item, `outputTranscription` → agent item; ids
  `g<connId>_<n>_u|a` (new `connId` per connection, so the server's `rt_<itemId>` dedupe never merges items
  across reconnects). A participant item is committed when the model has started answering (+1.2 s grace
  for late chunks), on `finished`, or after 3.5 s without an answer; it is always reported **before** the
  agent turn that answers it; an utterance that starts during the agent's turn (barge-in) stays open.
  Agent items are reported on `turnComplete`. Each item is sent once (`realtime.transcript`); partials show
  locally (`realtimeDelta`).
- Barge-in: `serverContent.interrupted` → `AudioPlayer.stopAll()` immediately; the agent turn is reported
  `interrupted:true` with the text cut at the heard-characters estimate (word boundary). Local stops (pause,
  typing) cut the same way and drop the rest of that turn's audio.
- Tools: `toolCall.functionCalls[{id,name,args}]` → `realtime.tool_call` (deduped by id) → server validates,
  authorizes, rate-limits, executes → `realtime.tool_result` → `sendToolResponse({ functionResponses: [{ id, name, response: { output } }] })`
  (one batch per tool-call message; 8 s safety flush); `toolCallCancellation` drops pending ids.
- `realtime.instruction` → `sendClientContent({ turns:[{ role:'user', parts:[{ text:'[Session runtime instruction — not said by the participant…]\n…' }] }], turnComplete: respond })`,
  **held while the model is generating** (client content interrupts generation) or tool calls are pending.
- Typed input in live mode is also handed to the model (`sendUserText`, both providers) — before, the
  OpenAI path persisted typed turns without the model hearing them.
- `sessionResumptionUpdate` → keep the latest resumable handle; `goAway` or an unexpected close →
  reconnect: fetch a new token with `{ resumeHandle }` (or `{ reconnect:true }` → transcript in the
  instructions), up to 3 attempts with backoff, then a fallback error (→ pipeline plan). Events from old
  connections are ignored.
- The hook re-plans on adapter errors (`fallback:true`) exactly like the OpenAI path; `stop()` closes the
  socket, mic nodes, VAD and player; the shared mic track is never stopped.

## API facts verified (and where)
All from `node_modules/@google/genai` **2.24.0** (`dist/genai.d.ts`, `dist/node/index.cjs`, `dist/web/index.mjs`)
plus `raw.githubusercontent.com/googleapis/js-genai/main/…` and `…/python-genai/main/…`:

| Fact | Source |
|---|---|
| `ai.authTokens.create({ config: { uses, expireTime, newSessionExpireTime, liveConnectConstraints:{model, config}, lockAdditionalFields?, httpOptions } })` → `AuthToken { name }`; defaults: expire 30 min, new-session 60 s, uses 1; resuming does not count as a use; Gemini Developer API + v1alpha only | `genai.d.ts` (`CreateAuthTokenConfig`, `AuthToken`, `class Tokens` doc comment); `sdk-samples/live_ephemeral.ts` |
| Wire request `POST v1alpha/auth_tokens { uses, expireTime, newSessionExpireTime, bidiGenerateContentSetup:{model:'models/…', generationConfig:{responseModalities, speechConfig}, systemInstruction, tools, sessionResumption, input/outputAudioTranscription, realtimeInputConfig, contextWindowCompression} }`; **no `fieldMask` when `lockAdditionalFields` is omitted = the whole setup is locked** ("global lock") | `convertBidiSetupToTokenSetup`/`createAuthTokenConfigToMldev` in `dist/node/index.cjs`; python `google/genai/tests/tokens/test_create.py` (`test_create_global_lock`); observed against a local server |
| Browser: `new GoogleGenAI({ apiKey: token.name, apiVersion:'v1alpha' })`; `live.connect` uses `…GenerativeService.BidiGenerateContentConstrained?access_token=auth_tokens/…` | `Live.connect` in `dist/web/index.mjs`; `test/unit/live_test.ts` |
| `live.connect({ model, config, callbacks:{onopen,onmessage,onerror,onclose} })`; resolves after `open`; hangs if the socket never opens | `Live.connect` implementation |
| `sendRealtimeInput({ audio: { data, mimeType:'audio/pcm;rate=16000' } })`, `{ audioStreamEnd:true }`, `{ text }`, `activityStart/End` | `LiveSendRealtimeInputParameters`; `test/system/node/live_test.ts`; `sdk-samples/live_server.ts` (`createBlob`) |
| `sendClientContent({ turns, turnComplete })` — client content interrupts current generation | `LiveClientContent` doc comment |
| `sendToolResponse({ functionResponses: [{ id, name, response }] })`; `FunctionResponse.response` uses `output` / `error` keys | `LiveSendToolResponseParameters`, `FunctionResponse` |
| Server messages: `setupComplete`, `serverContent { modelTurn.parts[].inlineData, inputTranscription{text,finished}, outputTranscription, interrupted, turnComplete, generationComplete, waitingForInput }`, `toolCall.functionCalls[{id,name,args}]`, `toolCallCancellation.ids`, `goAway.timeLeft`, `sessionResumptionUpdate{newHandle,resumable}`, `usageMetadata` | `LiveServerMessage`, `LiveServerContent`, `Transcription`, … in `genai.d.ts` |
| `realtimeInputConfig { automaticActivityDetection { startOfSpeechSensitivity, endOfSpeechSensitivity, prefixPaddingMs, silenceDurationMs, disabled }, activityHandling: START_OF_ACTIVITY_INTERRUPTS \| NO_INTERRUPTION }`; `contextWindowCompression { slidingWindow }`; `sessionResumption { handle, transparent }` | `genai.d.ts` |
| `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName` (free string) | `genai.d.ts` (`PrebuiltVoiceConfig`) — the voice **names** (Kore, Puck, Zephyr, …) are Google's documented list, **not verifiable offline**; unknown names are never sent |
| Live model `gemini-2.5-flash-native-audio-latest` (Gemini Developer API) | `sdk-samples/live_server.ts`; older samples/tests use `gemini-live-2.5-flash-preview` |
| Audio out: PCM16 24 kHz (`inlineData.mimeType` carries the rate; the player parses it) | Handled generically by `audio/pcm;rate=` parsing; 24 kHz is Google's documented output rate (not in the SDK types) |
| Text: `models.generateContentStream` (`POST v1beta/models/{m}:streamGenerateContent?alt=sse`) / `generateContent`; `systemInstruction`, `tools[].functionDeclarations[].parametersJsonSchema`, `responseMimeType:'application/json'` + `responseJsonSchema`; parts `text/thought/thoughtSignature/functionCall{id?,name,args}`; `finishReason`, `promptFeedback.blockReason`; `usageMetadata { promptTokenCount, candidatesTokenCount, thoughtsTokenCount, toolUsePromptTokenCount, cachedContentTokenCount }`; function responses as a `user` content (same as the SDK's automatic function calling) | `genai.d.ts`; `codegen_instructions.md`; SDK AFC code in `dist/node/index.cjs`; observed against a local server |
| Auth header `x-goog-api-key`; `models.list` at `v1beta/models`; invalid key → HTTP 400 `API_KEY_INVALID` | SDK (`GOOGLE_API_KEY_HEADER`); the 400 shape is Google's documented error format (not observable here — mocked) |

## How it was tested (actual results)
- **Shared** (`pnpm --filter @cf/shared test`): 71/71 (new `live-models.test.ts`: defaults, backward-compatible
  parsing, warnings, all templates still publish).
- **API jest** (`cd apps/api && PGPASSWORD=postgres pnpm test:prepare && npx jest --forceExit`): **373/373, 28 suites**. New:
  - `common/llm/google.provider.spec.ts` — real SDK against a local mock of the Gemini REST API: stream URL/key
    header, both system parts, JSON-schema function declarations, text vs thought parts, synthesized call ids,
    verbatim model-turn replay with `thoughtSignature`, `functionResponse` mapping (output/error), usage and
    stop-reason mapping (tool_use / max_tokens / refusal), structured JSON output; `LlmService.resolve` order.
  - `runtime/voice/live-providers.spec.ts` — token request shape (uses 1, 30 min / 2 min windows, **no
    fieldMask**, full setup, tools incl. `update_progress`/`end_session`/`fn_*`, voice, transcription, VAD,
    barge-in, resumption, compression), resume handle, no key / capability unchecked → 503; resolver:
    defaults, auto order, preferred→other→pipeline with reasons, model override rules, phone channel.
  - `runtime.e2e.spec.ts` "realtime mode (Google Gemini Live, auto)" — full Nest app + test DB + mock Gemini:
    session resolves Google (live) and Google (text, since Anthropic is absent), token minted with the
    compiled prompt and tools and never echoing the key/prompt, WS transcripts mirrored and **deduped**, tool
    call executed, **same per-session tool-call cap**, interrupted agent turn stored, resume-handle token,
    reconnect token with `<conversation_so_far>`, malformed handle 422, closing → COMPLETED, exactly one
    `REALTIME_SECONDS` row with provider `google`.
  - `providers.integration.spec.ts` — Google connection (LLM+REALTIME), verify via models.list with
    `x-goog-api-key` (key not in URL), 400 API_KEY_INVALID → invalid (key redacted), proxy 403 → network
    error, 200 → ACTIVE, status rows.
- **Playwright** against the compiled API (:4400, fresh `conversaforge_i` DB, migrated + seeded) and
  `next dev` (:3400):
  - `e2e/gemini-live.spec.ts` (2 tests) — a fake Gemini Live server via `page.routeWebSocket` driving the
    **real `@google/genai` browser SDK**: constrained endpoint + `access_token`, setup message without
    instructions/tools, PCM16 16 kHz ~100 ms chunks, opening instruction as a client turn, partials,
    playback starts, an instruction held back while the model speaks, `interrupted` stops playback
    immediately, agent turn reported interrupted + truncated, the deferred instruction sent after the turn,
    a full second turn, **each transcript mirrored exactly once** (4 unique items, no pipeline messages), tool
    call deduped → `realtime.tool_call` → `realtime.tool_result` → `toolResponse` with id/name/output,
    "I'm done" → `audioStreamEnd`, `sessionResumptionUpdate` + `goAway` → new token request with the handle →
    second connection whose setup carries it, new item ids after reconnect. Second test: 503 from the token
    endpoint → pipeline fallback with the "Live voice unavailable — using …" chip and notice.
  - `e2e/unit.spec.ts` +1 (plan per provider, labels, heard-text cut, PCM encoding) → 15/15;
    `realtime.spec.ts`, `live.spec.ts`, `voice.spec.ts`, `server-voice.spec.ts`, `tools.spec.ts`,
    `embed.spec.ts`, `scenarios.spec.ts`, `knowledge-providers.spec.ts` all pass.
  - `e2e/journeys.spec.ts`: **14/14** (journey 5 hit a one-off click timeout in one full run and passed on the
    immediate rerun; journeys 6–8 then passed).
- `tsc --noEmit` (API + web) clean; `next build` succeeds, the Gemini SDK is a separate lazy chunk.
- Environment note: headless Chromium here never settles `audioWorklet.addModule` (even without CSP), so the
  tests exercised the ScriptProcessor fallback after the 2 s timeout; real Chrome/Edge use the worklet.

## What needs a real key (not verified here)
- **Gemini Live end to end**: `GEMINI_API_KEY` (Gemini Developer API key; Vertex AI is not supported for
  ephemeral tokens) or a workspace **Google Gemini** connection with "Live voice" checked. To verify: token
  creation (v1alpha availability for the account), that the locked setup is honoured (the browser's setup is
  ignored), audio quality/latency, transcription timing vs our 1.2 s/3.5 s commit rules, barge-in feel,
  goAway/resumption with a locked `sessionResumption.handle`, voice names, and that 30-minute tokens + 2-minute
  connect windows fit your sessions (reconnects mint a fresh token automatically).
- **Gemini text**: same key — pipeline conversations (`GEMINI_TEXT_MODEL`), scoring/extraction with structured
  output (`GEMINI_ANALYSIS_MODEL`), drafting assistant, coach memory; check Gemini 3 thought-signature replay
  if you switch to a `gemini-3-*` model.
- **OpenAI Realtime**: unchanged — `OPENAI_API_KEY` (see B/C).
- Pricing rows for Gemini are estimates; update `pricing.ts` from Google's price list.

## Known limitations / notes
- Like OpenAI Realtime, Gemini Live transcripts and tool calls are relayed by the participant's browser: the
  server validates, authorizes and rate-limits every tool call, but transcripts are not tamper-proof — use the
  pipeline for high-stakes assessments (unchanged recommendation).
- Push-to-talk on Gemini gates the microphone and sends `audioStreamEnd` on release; server VAD stays on (the
  turn-detection mode is locked in the token and cannot be switched mid-session).
- `realtime.instruction` with `respond:false` is sent as a non-final client turn; the model folds it into its
  next answer. Instructions wait while the model is speaking.
- The resume handle is accepted from the browser (validated shape, rate-limited, same session only via its
  token); Google binds handles to the API key's project.
- Session resumption across a token's 30-minute `expireTime` relies on a fresh token + handle (implemented,
  unverified without a key).
