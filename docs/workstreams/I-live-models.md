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
| Shared config (additive) | `packages/shared/src/scenario-config.ts`: `model.voiceMode` default **`realtime`**; `model.realtimeProvider` ∈ `auto \| google \| openai` (default **`auto`**); `model.llmProvider` gains `google`; publish warnings for a live-model override that doesn't match the chosen provider and for live voice + phone/meeting channels. `protocol.ts`: `ClientRuntimeConfig.realtime.provider` is `openai \| google`, new optional `requestedVoiceMode`. Existing versions that say `openai`/`pipeline` are unchanged. |
| Env | `GEMINI_API_KEY` (alias `GOOGLE_API_KEY`), `GEMINI_LIVE_MODEL` (default `gemini-3.8-live`; `OPENAI_REALTIME_MODEL` backup default `gpt-realtime-2.1`), `GEMINI_TEXT_MODEL` (`gemini-2.5-flash`), `GEMINI_ANALYSIS_MODEL` (`gemini-2.5-pro`), `GEMINI_BASE_URL` (proxies/tests) — `apps/api/src/config/env.ts`, `/.env.example` |
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
  - `realtimeProvider:'auto'` → first provider with a live credential in the order **google → openai**; the next
    configured one is recorded as `providerInfo.realtime.backup` and used if the first fails in the browser
    (the adapter asks `realtime-token` with `provider:<backup>`, which switches the session and re-sends the history).
  - `'openai'`/`'google'` → that provider if configured, otherwise **the other one** with a reason
    ("Google Gemini Live was requested but no Google key (GEMINI_API_KEY …) is configured; using OpenAI Realtime instead."),
    otherwise `pipeline` with a reason.
  - A credential counts when a workspace connection for that provider has the **REALTIME** capability
    checked (or has no capability list), else the server env key.
  - Model: the scenario's `realtimeModel` when it belongs to the chosen provider (`gemini…` ↔ Google), else
    the connection's `realtimeModel`, else `OPENAI_REALTIME_MODEL` / `GEMINI_LIVE_MODEL`.
- Recorded as `providerInfo.realtime = { provider, model, source, backup? }`, `requestedRealtimeProvider`,
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
    realtimeInputConfig: { automaticActivityDetection: { startOfSpeechSensitivity: START_SENSITIVITY_LOW, endOfSpeechSensitivity: END_SENSITIVITY_LOW, silenceDurationMs: clamp(endOfTurnSilenceMs, 500..3000) },
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
- **Echo gate** (`mic-gate.ts`, `MicGate`): while the agent is audible (+300 ms hangover) mic chunks are *not*
  sent — through speakers the agent's own voice came back into the mic and Gemini's activity detection
  treated it as the participant interrupting (the agent stopped mid-sentence, then answered its own echo and
  repeated the greeting). The local energy VAD (raised threshold + 300 ms confirmation while the agent
  plays) opens the gate when the participant really talks; the last ≤500 ms of withheld audio (pre-roll)
  is sent first so the first syllable is kept, the agent is **ducked** (−12 dB) at once and, if the
  participant keeps talking for 1.2 s over a turn the model had already finished, playback is **cut** and
  the saved turn is updated with what was heard (`interrupted:true`). When the participant stops while the
  agent is still talking (no `interrupted` came back) → `audioStreamEnd`, so Gemini closes that activity.
  When the agent finishes, the pre-roll is only kept if energy was already rising (a quick overlapping
  reply); otherwise it is echo and dropped. Push-to-talk held always streams.
- Model audio (`serverContent.modelTurn.parts[].inlineData`, `audio/pcm;rate=24000`) → the shared
  `AudioPlayer` (WebAudio → speakers **and** the recording mix), `agentSpeaking` from audibility. The
  player treats the chunks as one stream: PCM is resampled to the AudioContext rate by a resampler that
  keeps its state across chunks (independently resampled 24 kHz chunks in a 44.1/48 kHz context clicked at
  every seam), buffers are appended gaplessly to one timeline, a **jitter buffer** holds 300 ms before a
  turn starts and before resuming after an underrun — the cushion grows by 150 ms per underrun (up to 1 s)
  because a live model's first seconds can arrive slower than real time — audio is held at most 1.2 s after
  the last chunk if the stream stops, the end of a turn flushes early, successive turns queue back to back
  instead of cutting each other off, stops fade over 20 ms, and `duck()` lowers the agent while the
  participant starts talking. `getStats()` (underruns, buffers, cushion) is exposed through `debugState()`.
- Transcripts: `inputTranscription` → participant item (`interimInputTranscription`, when the model sends
  it, only updates the caption), `outputTranscription` → agent item; `cleanTranscript()` strips Gemini's
  non-speech placeholders (`<no speech>`, `{pause}`, `<noise>`, also while they arrive in pieces) and
  punctuation-only fragments ("..."), so such turns are neither shown nor mirrored; ids
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
  **held until the model is idle** — client content interrupts whatever the model is generating, so an
  instruction waits while: the model is generating, we asked it for a response that has not started yet
  (opening line, typed text, tool results; 8 s cap), its audio is still playing here, the participant is
  talking or spoke in the last 2.5 s, or tool calls are pending (re-checked every 250 ms and on events).
- Typed input in live mode is also handed to the model (`sendUserText`, both providers) — before, the
  OpenAI path persisted typed turns without the model hearing them.
- `sessionResumptionUpdate` → keep the latest resumable handle; `goAway` or an unexpected close →
  reconnect: fetch a new token with `{ resumeHandle }` (or `{ reconnect:true }` → transcript in the
  instructions), up to 3 attempts with backoff, then a fallback error (→ pipeline plan). Events from old
  connections are ignored.
- The hook re-plans on adapter errors (`fallback:true`) exactly like the OpenAI path; `stop()` closes the
  socket, mic nodes, VAD and player; the shared mic track is never stopped.

### Call flow fixes after the first real Gemini run (2026-09-27)
A real call (Gemini Live, laptop speakers + mic) stuttered, the agent broke off mid-sentence, repeated the
greeting three times and every transcript line showed twice. Causes and fixes:

| Symptom | Cause | Fix |
|---|---|---|
| Crackly, choppy voice; breaks that resume mid-sentence | Each ~100–200 ms PCM chunk was scheduled as its own 24 kHz `AudioBuffer` in a 48/44.1 kHz context (resampled in isolation → click at every seam) and started the instant it arrived (any arrival jitter → audible gap; measured: Gemini delivered the first 2.5 s of a greeting at ~0.7× real time) | `AudioPlayer`: stateful resampling to the context rate, gapless timeline, 300 ms jitter buffer that grows after underruns (≤ 1 s), slow streams held up to 1.2 s instead of being played in fragments, coalesced buffers, faded stops |
| Agent stops and does not resume; greeting repeated; `...` agent turns; garbage participant transcripts | The agent's own voice came back through the mic; Gemini's server VAD (`START_SENSITIVITY_HIGH` by default) reported `interrupted`, the model then answered its own echo | Browser echo gate (`MicGate` + local VAD with a 400 ms echo warm-up and a 4× echo-floor bar, pre-roll, ducking, tail cut), `startOfSpeechSensitivity: START_SENSITIVITY_LOW` in the locked token setup, placeholder / punctuation-only transcriptions dropped |
| Agent cut off right after the greeting / after tool results | A `realtime.instruction` (nudge, timed instruction, closing) sent as client content between "response requested" and the first audio chunk, or while the last turn's audio was still playing, interrupted the model | Instructions wait until the model is idle (generating, awaiting response, audio playing, participant talking → hold) |
| Transcript rendered twice; last caption never cleared | The server saves live-model turns with `clientTurnId = rt_<itemId>`; the client store compared raw item ids, so streaming rows/captions were never replaced by the saved turn | `turnMatchesItem()` in `store.ts`; captions clear when the utterance commits; a participant utterance shows once while it is transcribed |
| New agent turn cut the previous one's last words | The player treated a second turn as superseding the first | Turns queue back to back; only barge-in/stop interrupts |

Verified against the real model: `apps/web/e2e/gemini-real.spec.ts` (opt-in, `E2E_REAL_GEMINI=1`,
`E2E_SCENARIO_NAME="Active listening coaching"`; `E2E_ECHO=0.5` feeds everything the page plays back into
the synthetic mic after 60 ms at half volume — worst-case speaker echo without echo cancellation). Result
2026-09-27 (headless Chrome, `gemini-3.8-live`): with echo, the greeting played as one continuous 4.8 s run,
0 underruns, mic gate closed for all 155 playing samples, no local speech start, mirrored once and not
interrupted, one transcript row; without echo the same (5.6 s run). Before the cushion tuning the same
greeting came out in 4 fragments with 3 underruns, and Gemini's silent-mic "`<no speech>{pause}`" turns
showed as agent rows.

Tests: `apps/web/e2e/unit.spec.ts` (resampler continuity and ratio, mic gate, VAD `aboveMs`, echo warm-up,
transcript cleaning, store dedupe with `rt_` ids), `apps/web/e2e/gemini-live.spec.ts` (same protocol expectations against the new
adapter; the session-socket proxy now also drops the real session's own `realtime.instruction` /
`realtime.tool_result` messages, since seeded scenarios run live voice by default, and token requests
carry `provider`), `realtime.spec.ts`, `live-providers.spec.ts` (VAD settings in the token). On a machine
where Chrome's fake capture device never resolves `getUserMedia` (macOS without a system microphone
permission for the launched browser), run the browser specs with `E2E_FAKE_MIC=1` (synthetic silent mic,
see `e2e/helpers.ts`) and `E2E_CHROMIUM=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.
Tunables: `PREBUFFER_S`/`REBUFFER_S`/`MAX_CUSHION_S`/`MAX_HOLD_MS` (`audio-player.ts`), `GATE_HANGOVER_MS`,
`PREROLL_CHUNKS`, `INPUT_SETTLE_MS`, `TAIL_CUT_MS` (`gemini-live.ts`), `agentWarmupMs`/`echoRatio`/`bargeInMs`
(`vad.ts`).

### Double questions, no thinking time, Spanish transcripts (2026-09-30)
A real "Behavioral interview" run (Gemini Live): almost every agent reply came twice, reworded
("Nice to meet you… could you tell me about a disagreement?" → "Thanks for sharing that. Could you tell me
about a disagreement?"), often landing while the participant had started answering, which felt like
constant interrupting. Parts of the participant's English came back as Spanish.

| Symptom | Cause | Fix |
|---|---|---|
| Every reply followed by a second, reworded one | The prompt asks for `update_progress` after the spoken text in every reply. As a (default) blocking Gemini function, the model waits for the result and then **generates again**; OpenAI's adapter likewise sent `response.create` after every tool result. Reproduced against the real `gemini-3.8-live` with no participant input: 3 turns re-asking the same question in 20 s | Server marks `update_progress` results `silent: true` (`realtime.tool_result`, additive). Gemini: `update_progress` is declared `behavior: NON_BLOCKING` in the locked token setup and answered with `scheduling: SILENT` (context only). OpenAI: no `response.create` when every result in the batch is silent. Real API after the change (direct key and locked ephemeral token): 1 turn, then quiet |
| Agent answers as soon as the participant pauses | Gemini's activity detection is silence-only (no semantic "unfinished sentence" check like OpenAI's semantic VAD); the default 1200 ms end-of-turn silence is short for thinking | `silenceDurationMs = endOfTurnSilenceMs + GEMINI_THINKING_PAD_MS` (800 ms, capped at 3000) → 2 s by default |
| English transcribed as Spanish | `inputAudioTranscription: {}` = per-utterance language auto-detection | `inputAudioTranscription.languageCodes = [basics.language]` (SDK 2.24 `AudioTranscriptionConfig.languageCodes`, accepted by the constrained endpoint) |

### Plain audio experiment (`?audio=plain`, 2026-09-30)
Question behind it: is our browser turn-taking layer (echo gate, local VAD deciding what Gemini hears,
ducking, tail cut, `START_SENSITIVITY_LOW`) helping, or fighting Gemini's own activity detection? Plain audio
is Google's reference setup: the mic streams continuously with the browser's echo cancellation only, and
Gemini alone decides turns and barge-in (`interrupted`).

- Switch: "Audio handling" (Managed / Plain) on the device-check screen, shown only for Gemini Live on
  sessions this browser started with ▶ Try it (`cf:selftest:<id>`, set by `startSelfRun`) or when plain is
  already on — participants' links never see it. `?audio=plain|managed` on the live page still works. The
  choice is remembered in that browser (`localStorage['cf.liveAudioMode']`); the call screen shows
  "Google Gemini Live (plain audio)". Code: `apps/web/src/lib/voice/audio-mode.ts`, `GeminiLiveAdapter.plain`.
  (The first URL-only version was never actually used in the user's tests: every token event said
  `plainAudio: false`.)
- Token: `POST …/realtime-token { plainAudio: true }` → no `startOfSpeechSensitivity` (Google's default);
  end-of-turn settings unchanged. Logged on the `provider.realtime_token` session event (`plainAudio`).
- Kept in both modes: the playback jitter buffer (audio quality, not turn-taking), holding client-content
  instructions while the model is busy (client content interrupts generation — protocol behaviour), silent
  `update_progress`, transcription language.
- What to compare (headphones, then laptop speakers): does the agent cut itself off or answer its own voice
  (echo), does it stop promptly when you talk over it, does it wait through thinking pauses. If plain holds
  up on speakers, the managed layer (`mic-gate.ts`, gating in `gemini-live.ts`) can be deleted.
- Tests: `live-providers.spec.ts` + `runtime.e2e.spec.ts` (token setup), `e2e/gemini-live.spec.ts` "plain audio"
  (mic keeps streaming while the agent plays; `interrupted` stops playback; the choice persists). and "device
  check: the audio switch…" (hidden on a participant link; Plain on your own call reaches the token request).

### Silence check-in in live voice (2026-09-30)
Before: the check-in existed only in the pipeline (`!this.realtime` in `tick()`), and the live models never
speak unprompted — a silent participant got no reaction until the wrap-up near the time limit. Now:
- The browser sends `participant.speaking` in live mode too (the server's `participantBusy()` then also holds
  realtime instructions while the participant talks).
- Agent turns mirrored from the live model set `agentBusyUntil = now + estimateSpeechMs(text)` (playback
  still running when the turn is reported), so silence is measured from about the end of the agent's audio.
- After `turnTaking.silenceCheckInMs` (default 25 s) with the agent's turn last: one
  `realtime.instruction { text: <silence_check_in trigger>, respond: true, cancelOnSpeech: true }` per
  silence (logged `silence.check_in`); speech resets it.
- `cancelOnSpeech` (additive protocol field): the Gemini adapter drops a queued check-in when the
  participant speaks or is transcribed before the model is free to take it. OpenAI adds it immediately.
- Tests: `runtime.e2e.spec.ts` "realtime mode: silence check-in…", `e2e/gemini-live.spec.ts` plain-audio test
  (a queued check-in is dropped on speech; an unqueued one is sent with `turnComplete: true`).

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
