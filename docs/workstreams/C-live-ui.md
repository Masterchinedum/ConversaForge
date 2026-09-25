# Workstream C — Live participant experience

Web only. The participant call page, client voice adapters, reconnection, recording, tool panels, and the embeddable widget.

## What was built

### Pages
| Route | What |
|---|---|
| `/live/[sessionId]` | Participant call page, no login. The token comes from the `#t=<cfs_…>` fragment, which is moved into `sessionStorage` + `localStorage` (`cf:session:<id>`) and stripped from the URL. Otherwise it is read from storage. Optional `?return=<same-origin relative path>` shows "Back to course". The layout sets `robots: noindex` and `referrer: no-referrer`. |
| `/embed/frame` | The iframe used by `embed.js`. Handles the postMessage handshake, the parent-origin check, embed-token or share-link session creation, frame-reload resume, and the compact call UI. |
| `public/embed.js` | Dependency-free SDK: `ConversaForge.init({...})` returns `{ iframe, sessionId, end(), destroy() }`. |
| `public/embed-example.html` | Copy-paste demo host page with an event log. |

### Flow (`src/components/live/`)
`LiveApp` is a phase machine:

1. **Loading.** Missing or invalid tokens get friendly guidance. 401/403 shows "This link is not valid", 404 shows "Session not found", other errors offer a retry.
2. **Intro** (`IntroScreen`). Scenario name, description, instructions, estimated duration, persona and avatar, and workspace branding (`--brand-*` CSS variables from `primaryColor`, darkened when needed so white text on the brand color stays readable). It honors `hidePoweredBy` and shows a **simulated** banner when `config.simulated`.
3. **Consent** (`ConsentScreen`). States what is transcribed, recorded (audio/video) and analyzed, the retention days and the organizer's notice. When browser speech recognition is likely to be used, it adds a note that the browser vendor's speech service may process audio. There is one required acknowledgment. Recording is optional (the call still works if declined). Analysis is optional unless the bootstrap says `analysisRequired`. Submits `POST /consent`, then reloads the bootstrap because the runtime config's recording flags depend on consent.
4. **Device check** (`DeviceCheck`). Explains the microphone before prompting. Handles denied, missing, in-use, insecure-context and unsupported devices with specific instructions. Also provides:
   - a live level meter (AnalyserNode)
   - speaker test (a TTS sample in browser-voice mode, otherwise a chime) and output selection via `setSinkId` where supported
   - camera preview, only when `audio.allowCamera` or video recording was consented
   - microphone and camera selectors, remembered in `localStorage`
   - capability detection (speech recognition, speech synthesis, MediaRecorder, WebRTC) with the chosen voice mode shown
   - "Type instead" (this releases the microphone)
   - On refresh mid-call it becomes **"Rejoin your conversation"**, skipping intro and consent.
5. **Call** (`CallScreen`), responsive:
   - Layout is single-column on mobile and has an artifact side panel at `lg`.
   - Header shows the status pill (Connecting / Live / Reconnecting / Offline / Paused / Ending / Ended), a red **Recording** dot (only while `MediaRecorder.state === 'recording'`), elapsed and remaining time, the "Voice: …" mode label and the simulated badge.
   - The agent avatar has a speaking ring that respects reduced motion (`motion-safe:`), plus an activity line ("Listening… take your time" during thinking pauses).
   - Captions are an `aria-live=polite` log. Participant partial text shows as a grey dashed bubble.
   - Controls: Mute/Unmute, Pause/Resume, Push-to-talk toggle, a hold-to-talk button (pointer or Space/Enter; holding Space anywhere outside text fields also works), "I'm done answering", Switch to typing, and End with a confirmation dialog.
   - Also on screen: typed input, dismissible notices, a take-over panel when the session is superseded, and the tool panel.
6. **End** (`EndScreen`). Thanks and duration, "View your feedback" (`/report/<id>`, only when `report.participantCanSeeFeedback` and analysis was not declined), and "Back to course". Separate wording for FAILED, ABANDONED, EXPIRED and CANCELLED.

### Session connection (`src/lib/live/`)
- **`connection.ts` (`SessionConnection`):**
  - `hello`/`welcome` handshake (with `lastSeq` on reconnect), ping every 15 s, and a forced reconnect when nothing is received for 40 s.
  - Exponential backoff with jitter (0.5–15 s), up to 40 attempts. `online`/`offline` events are handled.
  - Close codes: 4001 is fatal auth, 4002 is terminal and goes to the end screen, 4003 is superseded (with a "Continue here instead" take-over button), 4004 is a protocol error, and 4029 backs off longer.
  - **Unacknowledged `participant.final` messages are kept by `clientTurnId` and resent after every welcome** until a `turn.saved` or welcome transcript acknowledges them. Durable messages (control, tool.*, agent.playback, realtime.*) are queued while disconnected. Transient ones (partials, speaking) are dropped.
- **`store.ts`.** Reducer: transcript upserted by turn id (B may resend a turn after barge-in truncation), sorted by seq, never duplicated. Also holds streaming agent text by turnId, optimistic typed or spoken turns by clientTurnId, tools, timer, notices and fatal state.
- **`use-live-call.ts`.** Wires the connection, store, voice adapter and recorder:
  - Audio and the voice adapter are set up **before** `start` is sent, so the greeting is spoken and its playback reported.
  - Agent deltas are chunked into sentences and spoken as they arrive.
  - Handles `realtime.tool_result` and `realtime.instruction`.
  - An adapter error with `fallback: true` re-plans to the next mode and shows a notice.
- **`recorder.ts` (`CallRecorder`).**
  - Records a WebAudio mix of the microphone and agent audio (server TTS / realtime remote track), plus the camera when video is consented. MediaRecorder uses a 5 s timeslice.
  - `POST /recordings` is sent once the session is **ACTIVE** (B refuses earlier). Parts go to `PUT …/parts/:n` (1-based, idempotent) sequentially, with retry and backoff (8 attempts). Then `POST …/complete {durationMs}`.
  - On `pagehide`, the last parts (up to 60 KB) and `complete` are sent with `keepalive` fetches. Each page load that records creates its own asset (B allows up to 6 per session).
- **`devices.ts`, `token.ts`, `runtime-api.ts`.** `runtime-api.ts` is the REST client and tolerantly normalizes B's bootstrap.

### Voice adapters (`src/lib/voice/`)
All adapters implement `VoiceClient { start, stop, setMuted, setPaused, speak(turnId, text, {final}), cancelSpeech, commitNow, setPushToTalk, setTalking, on(event) }`. Events: `partial`, `final`, `speaking`, `playback`, `thinking`, `agentSpeaking`, `level`, `notice`, `error`, `realtime*`.

- **`end-of-turn.ts` (`EndOfTurnDetector`).** Accumulates recognized text and commits after `endOfTurnSilenceMs` of silence. If the utterance looks incomplete, it waits up to `thinkingPauseGraceMs` since the last speech and emits `thinking` for the "take your time" indicator. An utterance counts as incomplete when it:
  - ends with a filler or conjunction (um, uh, so, and, because, but, like, I think, you know…)
  - has fewer than 3 words
  - ends with a comma or ellipsis
  - contains "let me think" or "give me a second"-style phrases near the end

  Voice activity (VAD) holds the commit. Push-to-talk release and "I'm done" commit immediately.
- **`vad.ts`.** Energy VAD with an adaptive noise floor. While agent audio plays, the threshold is raised (a separate echo floor) and speech must be **sustained ≥300 ms** to count as barge-in.
- **`browser-speech.ts` (`BrowserSpeechAdapter`).**
  - Uses `SpeechRecognition`/`webkitSpeechRecognition` (continuous, interim results, `lang` from config).
  - Restarts automatically on `end` (including Chrome's ~60 s cutoff), with backoff on network errors. After 6 errors in 30 s it falls back.
  - Recognition is paused while the agent speaks unless barge-in is allowed. With barge-in, it keeps listening, and the energy VAD or ≥2 non-echo words stop agent speech. An **echo filter** drops recognized text that is mostly words of the agent's current turn.
  - Partials are throttled to 250 ms, and `participant.speaking` edges are sent.
- **`server-pipeline.ts` (`ServerPipelineAdapter`).**
  - VAD segments raw PCM from the microphone into WAV (16 kHz mono with 450 ms pre-roll) and posts it as a binary `POST /stt`.
  - The returned text feeds the same end-of-turn detector. A 503 from the server triggers fallback.
  - This uses PCM rather than MediaRecorder webm: each segment is a self-contained file, and the pre-roll keeps the first syllable.
- **`speaker.ts`.** Agent output is independent of input:
  - **`ServerSpeaker`** plays `agent.audio` WebSocket chunks when present, otherwise uses `POST /tts`. Playback goes through `AudioPlayer` (WebAudio queue, instant stop, spoken-character estimate, recording mix).
  - **`BrowserSpeaker`** uses `SynthSpeaker` (`speechSynthesis`):
    - picks a voice by `voiceId` name match, then exact language, then language prefix
    - `rate = voice.speed`
    - boundary events give `spokenChars`
    - a Chrome keep-alive `resume()` every 10 s and a watchdog for platforms that never fire `onend`
- **`openai-realtime.ts` (`OpenAIRealtimeAdapter`).** GA WebRTC flow:
  - `POST …/realtime-token` returns `{ clientSecret, callsUrl }`. The browser creates an `RTCPeerConnection`, adds the shared microphone track, opens data channel `oai-events`, creates an offer, and `POST`s the SDP to `https://api.openai.com/v1/realtime/calls` with `Authorization: Bearer <ephemeral>` and `Content-Type: application/sdp`. The answer SDP is applied.
  - The remote track plays in `<audio autoplay>` and is mixed into the recording.
  - Transcripts are mirrored as `realtime.transcript`, from `conversation.item.input_audio_transcription.*` and `response.output_audio_transcript.*` (the beta `response.audio_transcript.*` names are also handled).
  - Function calls are forwarded as `realtime.tool_call`, deduplicated between `response.output_item.done` and `response.function_call_arguments.done`.
  - `realtime.tool_result` is sent back as a `function_call_output` item plus `response.create`. `realtime.instruction` becomes a system message item. Events issued before the data channel opens are queued.
  - Barge-in: `input_audio_buffer.speech_started` while the model's audio is playing marks that item `interrupted`. `cancelSpeech` sends `response.cancel` + `output_audio_buffer.clear`.
  - Push-to-talk sets `turn_detection: null` and uses `input_audio_buffer.clear`/`commit`.
- **`typed.ts` (`TypedAdapter`).** Text input only. Agent replies are spoken when a speaker is available; otherwise playback is reported as completed so the server doesn't wait.
- **`index.ts`.** `planVoice(config, capabilities, {hasMic, unavailable, preferTyped})` picks the mode:
  1. realtime, if `voiceMode === 'realtime'` and WebRTC is available
  2. server STT, if `stt` is openai or deepgram
  3. browser speech
  4. typed

  Output is server TTS when `tts` is openai or elevenlabs, otherwise browser, otherwise none. Runtime failures add keys to `unavailable`, and the plan is recomputed.

### Tool panels (`src/components/live/tools/`)
Tools render only when presented, and `tool.close` hides them. Participant-openable tools (`config.participantTools`) get "Open notepad", "Upload a document" and "Open whiteboard" buttons that send `tool.open`.

- **cards:** title and body.
- **notepad:** debounced (600 ms) `tool.update {content}`. Remote updates are accepted when the participant is not typing.
- **multiple_choice:** radio or checkbox, then `tool.response {selected: number[], answers}`.
- **document_upload:** client-side type and size checks from `UPLOAD_LIMITS.toolDocument`, then multipart `POST /uploads?toolCallId=…`. The upload itself answers the tool server-side, so no `tool.response` is sent.
- **timer:** a countdown with a polite live region that announces minutes and the last 10 s.
- **whiteboard:**
  - Agent `nodes`/`edges` render as a layered SVG diagram with an accessible description.
  - The participant can draw freehand on a canvas (pointer events, DPR-aware).
  - "Share sketch" sends `tool.update {summary, sketch: <≤17 KB JPEG data URL>}` + `tool.response {summary}`.
  - B's upload allowlist has no images, so the sketch is kept in tool state rather than uploaded as a PNG.

## How it was tested (real API)
Everything below ran against **workstream B's real runtime** (compiled to `apps/api/.dist-c`, API on :4103, web dev server on :3103), with the seeded demo workspace and the simulator LLM. Commands:

```
cd apps/api && npx tsc -p tsconfig.build.json --outDir .dist-c
PORT=4103 WEB_PUBLIC_URL=http://localhost:3103 API_PUBLIC_URL=http://localhost:4103 RUN_WORKERS_IN_API=true node .dist-c/main.js
cd apps/web && NEXT_DIST_DIR=.next-c WEB_PORT=3103 API_INTERNAL_URL=http://localhost:4103 NEXT_PUBLIC_API_WS_URL=ws://localhost:4103 pnpm dev
E2E_WEB_URL=http://localhost:3103 E2E_API_URL=http://localhost:4103 \
E2E_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/conversaforge \
  npx playwright test e2e/unit.spec.ts e2e/live.spec.ts e2e/tools.spec.ts e2e/embed.spec.ts e2e/voice.spec.ts e2e/server-voice.spec.ts e2e/realtime.spec.ts
```

**Result: 28/28 passed** (about 1.3 min). The specs use Chromium at `/opt/pw-browsers/chromium` with fake media devices. Sessions are created through B's member self-run endpoint as the seeded `creator@demo.test`. The login cookie is cached in `node_modules/.cache/cf-e2e` because login is rate-limited.

- **`live.spec.ts`:**
  - Missing token shows guidance.
  - An invalid token shows a friendly error, and the fragment is stripped.
  - **Full session:** intro (simulated banner) → consent → device check → call.
    - Headless recognition fails with `audio-capture` and falls back to Typed automatically; the notice is shown.
    - Several typed turns get simulated agent replies.
    - **Reconnect:** the socket is dropped, a `participant.final` is sent while disconnected, and it is delivered exactly once after reconnect. The same `clientTurnId` is re-sent and deduplicated. There are no duplicate rows in the UI or the DB (count of seq equals count of distinct seq; no duplicate `clientTurnId`).
    - **Recording:** ≥2 parts uploaded after about 11 s (checked in the DB), and assets are `READY` after the end (about 120 KB webm for about 15 s).
    - **Refresh mid-call:** "Rejoin" → same transcript, no duplicates, the conversation continues.
    - End → confirm → end screen with the `/report/<id>` link and "Back to course". The DB shows `COMPLETED`. Reopening shows the end screen. There are no console errors apart from a favicon 404.
  - Pause/resume: server state `PAUSED`, the recording indicator hides while paused, input is disabled.
  - Declining recording: no indicator and no `MediaAsset` rows.
  - Second tab supersedes the first, then "Continue here instead" takes it back.
  - At 360 px wide there is no horizontal overflow.
- **`tools.spec.ts`:**
  - Real server round-trips for notepad (content persisted in `Session.runtimeState`), document upload (SYSTEM turn "uploaded a document"), and whiteboard share (SYSTEM turn with the summary; the sketch data URL is sent).
  - Cards, multiple choice (`tool.response {selected:[1]}`), timer, a whiteboard diagram SVG, `tool.close`, and upload validation are verified by injecting `tool.present` frames into the real WebSocket with `page.routeWebSocket`. The simulator LLM never calls agent-only tools.
- **`embed.spec.ts`:**
  - A `cfe_` token minted through E's endpoint, then `embed-example.html`: handshake, `session.created` and `ready`, the iframe URL contains no token, a full call inside the frame, `session.state ACTIVE`, then host `end()` gives `session.ended` and the end screen. In the DB, `channel=EMBED` and `Participant.externalId = lms-user-42`.
  - A token restricted to another origin is refused before any session is created.
- **`voice.spec.ts`:** A scripted `SpeechRecognition` with Chrome's event shape plus a silent fake microphone, running the real UI.
  - Grey partials appear.
  - "…is, um" is **not** committed after 3 s and shows "Listening… take your time". The continuation is committed as **one** turn.
  - A complete sentence commits after more than 1 s of silence.
  - "Yes" waits, and "I'm done answering" commits it.
  - Mute stops recognition. Push-to-talk captures only while held and commits on release.
- **`server-voice.spec.ts`:** The welcome config is rewritten to `stt/tts=openai`, and `/stt` and `/tts` are fulfilled by the test. The fake microphone plays 1.2 s of tone then 4 s of silence.
  - VAD segments are posted as WAV (`RIFF…WAVE`), and the transcript is committed as `server_stt`.
  - The greeting plays via `/tts` through WebAudio, and `agent.playback started,completed` is reported.
  - `participant.speaking` is sent.
- **`realtime.spec.ts`:** The realtime token is mocked, and the SDP `calls` endpoint is answered by a second in-page `RTCPeerConnection` that plays OpenAI's side.
  - The request is checked: Bearer ephemeral key, `application/sdp`, an audio and a data-channel m-line, and the channel label `oai-events`.
  - User and assistant transcripts (with `interrupted` after `speech_started`) and one deduplicated tool call are mirrored to the server.
  - `realtime.tool_result` and `realtime.instruction` reach the model as `function_call_output` + `response.create` and a system item.
  - "I'm done" sends `input_audio_buffer.commit`.
- **`unit.spec.ts` (14 tests):** end-of-turn heuristics and timing (fake clock), VAD barge-in thresholds, echo filter, sentence chunker, reducer dedupe (streaming, optimistic, re-send, truncation upsert, resume), backoff, return-URL and token validation, bootstrap normalization, diagram layout, and brand colors.
- `tsc --noEmit` is clean for all C files, and `next build` (separate dist dir) succeeds with `/live/[sessionId]` and `/embed/frame`.

## Not verifiable here (needs real browsers or credentials)
- **Real Web Speech recognition** (Chrome or Edge with Google's speech service). Headless Chromium has no working recognizer; the adapter logic is covered with a scripted recognizer, so live recognition quality, Chrome's 60 s cutoffs and echo behavior on real speakers were **not** observed.
- **speechSynthesis output.** Headless Chromium has no voices, so the watchdog path was exercised instead. Voice selection and boundary events are untested on real voices.
- **OpenAI Realtime over WebRTC with a real model** (needs `OPENAI_API_KEY` or a workspace OpenAI connection so B can mint `client_secrets`). The handshake shape and event handling are tested against a local fake peer only. Event names follow the GA API (`response.output_audio_transcript.*`, `output_audio_buffer.*`, `conversation.item.input_audio_transcription.*`). The official docs host was blocked from this environment, so these names were cross-checked against the `openai-agents-js` WebRTC transport source.
- **Real server STT/TTS providers** (OpenAI, Deepgram, ElevenLabs keys). Tested with mocked endpoints.
- **Barge-in on real hardware** (acoustic echo levels, AEC behavior with speechSynthesis). The thresholds are unit-tested only.
- Safari and Firefox (Firefox has no Web Speech recognition, so the plan falls back to server or typed).

## Known limitations / design notes
- speechSynthesis audio cannot be captured, so in browser-voice mode the recording contains only the participant. The call screen states this.
- A refresh mid-call starts a **new recording asset** for the rest of the call. Assets are not merged.
- The whiteboard sketch is stored as a small JPEG data URL in the tool state (under the protocol's 20 KB tool payload limit), not as an uploaded asset.
- `window.__cfLive` (drop and inspect hooks for e2e) is only defined when `NODE_ENV !== 'production'`.

## Notes for other workstreams
- **B:**
  - Unresolved `{{placeholders}}` appear in `persona.role` when a variable is not supplied (e.g. "…for the {{role_title}} role" in the seeded behavioral interview). Consider substituting a neutral default or stripping it server-side.
  - The client sends `start` only after its audio is ready, and relies on `turn.saved` ids equal to `agent.start` turnIds (as documented).
- **D:** The end screen links to `/report/<sessionId>`. The participant token is available in `sessionStorage`/`localStorage['cf:session:<id>']`.
- **E/F:** Create a session, store the token under `cf:session:<id>` (or pass `#t=<token>`), then navigate to `/live/<id>?return=<relative url>`.
- The `apps/web/playwright.config.ts` added here is shared. It reads `E2E_WEB_URL`/`E2E_API_URL` and uses `/opt/pw-browsers/chromium` (override with `E2E_CHROMIUM`).
- Next dev servers started with `NEXT_DIST_DIR=.next-<ws>` append `.next-<ws>/types/**/*.ts` to `apps/web/tsconfig.json`'s `include` (all workstreams' servers did this). The lead may want to reset that list.
